/*
 * player.js —— 回放引擎（注入目标页面运行，支持导航断点续跑）
 *
 * 按步骤 DSL 逐条执行：goto / click / input / select / checkbox / upload / download / key / wait / assert
 *
 * 关键设计：页面导航会销毁 content script。因此遇到 goto（整页跳转）时，
 * player 记录「断点（nextIndex）」并上报 background；background 监听该 tab 加载完成后
 * 重新注入 player 并从断点继续执行（resume）。
 *
 * 上传步骤：定位 file input 后请求 background 用 CDP（DOM.setFileInputFiles）写入本地文件路径；
 * CDP 不可用或文件不存在时降级为 MANUAL，等待用户手动选择后点「继续」。
 */
(function () {
  'use strict';
  if (window.__WBOT_PLAYER__) return;
  window.__WBOT_PLAYER__ = true;

  const W = window.__WBOT__;
  if (!W) return; // 需要 selector.js 先行注入

  const DEFAULT_TIMEOUT = 15000;
  const RETRY = 2;
  const state = {
    running: false,
    steps: [],
    index: 0,
    skippedOnError: true,
    manualWaiter: null
  };

  function report(payload) {
    chrome.runtime.sendMessage(Object.assign({ type: 'WBOT_PLAY_PROGRESS' }, payload)).catch(() => {});
  }

  function sleep(ms) {
    return W.waitMs(ms);
  }

  function currentUrl() { return location.href; }

  function waitUntil(fn, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function tick() {
        try { if (fn()) return resolve(true); } catch (e) {}
        if (Date.now() - t0 > timeoutMs) return reject(new Error('等待条件未满足（超时 ' + timeoutMs + 'ms）'));
        setTimeout(tick, 250);
      })();
    });
  }

  function waitLoc(spec) {
    if (Array.isArray(spec)) return spec;
    if (spec && spec.loc) return spec.loc;
    if (spec && spec.target) return spec.target;
    if (spec && spec.value) return [{ kind: 'css', value: spec.value }];
    return [];
  }

  async function waitPage(waitSpec, stepTimeout) {
    if (!waitSpec) return;
    if (waitSpec.type === 'url') {
      const target = waitSpec.url || waitSpec.value;
      if (target) await waitUntil(() => currentUrl().indexOf(target) !== -1, stepTimeout);
    } else if (waitSpec.type === 'element') {
      await W.waitForLocators(waitLoc(waitSpec), stepTimeout);
    } else if (waitSpec.type === 'text') {
      await waitUntil(() => W.deepText(document.body).indexOf(waitSpec.value) !== -1, stepTimeout);
    } else if (waitSpec.type === 'time') {
      await sleep(parseInt(waitSpec.ms || waitSpec.value, 10) || 500);
    }
  }

  /* 每步执行（单次尝试），返回 {nav?:boolean, nextIndex?:number} 表示发生整页导航 */
  async function execOne(step, stepTimeout) {
    switch (step.action) {
      case 'goto': {
        const url = step.url;
        if (currentUrl() !== url) {
          report({ kind: 'nav', desc: '整页跳转 ' + url.slice(0, 80) });
          location.href = url;
          // 导航触发后脚本即将销毁，立即返回导航标记
          return { navigated: true };
        }
        await waitPage(step.wait, stepTimeout);
        return {};
      }
      case 'click': {
        const el = await W.waitForLocators(step.target, stepTimeout);
        W.clickElement(el);
        // 若发生整页导航，click 后的等待会因页面销毁失败；交由 wait/断点处理
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'input': {
        const el = await W.waitForLocators(step.target, stepTimeout);
        W.setInputValue(el, String(step.value == null ? '' : step.value));
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'select': {
        const el = await W.waitForLocators(step.target, stepTimeout);
        if (step.value) {
          const opt = Array.prototype.find.call(el.options || [], (o) =>
            o.textContent.trim() === String(step.value) || o.value === String(step.value)
          );
          if (opt) W.setSelectValue(el, opt.value);
        }
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'checkbox': {
        const el = await W.waitForLocators(step.target, stepTimeout);
        W.setCheckbox(el, !!step.checked);
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'upload': {
        await execUpload(step, stepTimeout);
        return {};
      }
      case 'download': {
        const el = await W.waitForLocators(step.target, stepTimeout);
        report({ kind: 'download-start', desc: '触发下载' });
        W.clickElement(el);
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'key': {
        const el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, code: step.key, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, code: step.key, bubbles: true }));
        await afterStep(step, stepTimeout);
        return {};
      }
      case 'wait': {
        if (step.type === 'time') await sleep(parseInt(step.value || step.ms, 10) || 1000);
        else if (step.type === 'element') await W.waitForLocators(waitLoc(step), stepTimeout);
        else if (step.type === 'text') await waitUntil(() => W.deepText(document.body).indexOf(step.value) !== -1, stepTimeout);
        else if (step.type === 'url') await waitUntil(() => currentUrl().indexOf(step.value) !== -1, stepTimeout);
        else await sleep(500);
        return {};
      }
      case 'assert': {
        let pass = false;
        if (step.type === 'url') pass = currentUrl().indexOf(step.value) !== -1;
        else if (step.type === 'text') pass = W.deepText(document.body).indexOf(step.value) !== -1;
        else if (step.type === 'element') pass = !!W.locate(waitLoc(step));
        if (!pass) throw new Error('断言失败: ' + step.type + ':' + step.value);
        return {};
      }
      default:
        throw new Error('未知动作: ' + step.action);
    }
  }

  async function afterStep(step, stepTimeout) {
    if (!step.wait) { await sleep(400); return; }
    await waitPage(step.wait, stepTimeout);
  }

  /* 步骤执行（含重试） */
  async function execStep(step, stepTimeout) {
    const attempts = RETRY + 1;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await execOne(step, stepTimeout);
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await sleep(1000);
      }
    }
    throw lastErr || new Error('步骤执行失败');
  }

  /* 上传：优先 CDP，失败降级 MANUAL */
  async function execUpload(step, stepTimeout) {
    let input = null;
    if (step.target && step.target.length) {
      const el = await W.waitForLocators(step.target, stepTimeout);
      input = el && el.tagName === 'INPUT' && el.type === 'file' ? el : (el && el.querySelector ? el.querySelector('input[type=file]') : null);
      if (!input) W.clickElement(el);
    }
    if (!input) {
      const t0 = Date.now();
      while (!input && Date.now() - t0 < stepTimeout) {
        input = document.querySelector('input[type=file]');
        if (!input) await sleep(300);
      }
    }
    if (!input) throw new Error('未找到文件上传控件');

    const files = step.files || [];
    if (!files.length) throw new Error('上传步骤未配置文件');

    const resp = await chrome.runtime.sendMessage({
      type: 'WBOT_PLAY_UPLOAD',
      files: files
    }).catch(() => null);

    if (resp && resp.ok) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await afterStep(step, stepTimeout);
      return;
    }
    if (resp && resp.mode === 'MANUAL') {
      report({ kind: 'manual', desc: '请手动选择文件：' + files.join('、') });
      await new Promise((resolve) => { state.manualWaiter = resolve; });
      await afterStep(step, stepTimeout);
      return;
    }
    throw new Error('上传失败: ' + (resp && resp.error ? resp.error : '未知'));
  }

  function resumeManual() {
    if (state.manualWaiter) {
      const w = state.manualWaiter;
      state.manualWaiter = null;
      w();
    }
  }

  /* ============ 执行主入口（支持 fromIndex 断点续跑） ============ */
  async function run(config, fromIndex) {
    if (state.running) return { ok: false, error: '已有流程在运行' };
    state.running = true;
    state.steps = config.steps || [];
    state.index = fromIndex || 0;
    state.skippedOnError = config.skippedOnError !== false;
    const stepTimeout = config.stepTimeout || DEFAULT_TIMEOUT;
    const total = state.steps.length;

    report({ status: 'start', total: total, resumeFrom: state.index });

    while (state.index < total) {
      const step = state.steps[state.index];
      const idx = state.index + 1;
      report({ status: 'step', index: idx, id: step.id, desc: step.desc || step.action });
      try {
        const r = await execStep(step, stepTimeout);
        if (r && r.navigated) {
          // 整页导航：上报断点，由 background 注入续跑
          state.running = false;
          report({ status: 'nav', index: idx, nextIndex: state.index + 1, url: currentUrl().slice(0, 200) });
          return { ok: true, navigated: true, nextIndex: state.index + 1 };
        }
        report({ status: 'pass', index: idx, id: step.id });
        state.index++;
      } catch (e) {
        report({
          status: 'fail', index: idx, id: step.id, error: e.message,
          snapshot: { url: currentUrl().slice(0, 300), text: W.deepText(document.body).slice(0, 80) }
        });
        if (!state.skippedOnError) {
          state.running = false;
          report({ status: 'end', ok: false, failAt: idx, error: e.message });
          return { ok: false, failAt: idx, error: e.message };
        }
        state.index++; // 跳过继续
      }
    }

    state.running = false;
    report({ status: 'end', ok: true, total: total });
    return { ok: true, total: total };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'WBOT_PLAY') return;
    if (msg.control === 'run') {
      run(msg.config || {}, msg.fromIndex || 0)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.control === 'stop') {
      state.running = false;
      resumeManual();
      sendResponse({ ok: true });
    }
    if (msg.control === 'continue') {
      resumeManual();
      sendResponse({ ok: true });
    }
  });
})();