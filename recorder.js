/*
 * recorder.js —— 录制引擎（注入目标页面运行）
 *
 * 监听用户在页面上的真实操作，将其转成结构化步骤 DSL：
 *   click / input / select / checkbox / upload / download / key / goto
 * 支持：
 *  - 输入防抖合并（连续打字只记一条最终值）
 *  - SPA 路由变化识别（pushState/replaceState/hashchange → goto）
 *  - 下载触发识别（a[download] / 文件型 href / blob 点击）
 *  - 文件上传记录（input[type=file]）
 *  - 顶部录制 HUD（红色浮条显示步骤数）
 *
 * 通过 chrome.runtime 与 background 通信。
 */
(function () {
  'use strict';
  if (window.__WBOT_RECORDER__) return;
  window.__WBOT_RECORDER__ = true;

  const W = window.__WBOT__;
  if (!W) return; // 需要先注入 selector.js

  const CONFIG = {
    inputDebounceMs: 300,   // 输入防抖
    navDebounceMs: 600,     // 导航防抖
    downloadExt: /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|txt|csv|jpg|jpeg|png|gif|svg|mp4|mp3)(\?.*)?$/i
  };

  const state = {
    running: false,
    steps: [],
    lastInput: null,   // {timer, el, target, start}
    lastNav: null,
    busy: false
  };

  let hud = null; // 录制状态浮条

  /* ============ HUD ============ */
  function ensureHud() {
    if (hud && hud.isConnected) return hud;
    hud = document.createElement('div');
    hud.id = '__wbot_hud__';
    hud.style.cssText =
      'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483646;' +
      'background:rgba(220,38,38,.95);color:#fff;padding:6px 14px;border-radius:20px;' +
      'font:600 13px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);' +
      'pointer-events:none;white-space:nowrap;';
    document.body.appendChild(hud);
    return hud;
  }

  function removeHud() {
    if (hud && hud.isConnected) hud.remove();
    hud = null;
  }

  function updateHud() {
    if (!state.running) return;
    const el = ensureHud();
    el.textContent = '● 录制中 · 已记录 ' + state.steps.length + ' 步 · 点击面板「停止录制」结束';
  }

  /* ============ 工具 ============ */
  function push(step) {
    step.id = W.uid('s');
    step.created = Date.now();
    state.steps.push(step);
    updateHud();
    chrome.runtime.sendMessage({ type: 'WBOT_REC_STEP', step }).catch(() => {});
  }

  function buildTarget(el) {
    return W.buildLocators(el);
  }

  /* 强制落盘待定的输入步骤（保证操作顺序正确） */
  function flushPendingInput() {
    if (state.lastInput && state.lastInput.timer) {
      clearTimeout(state.lastInput.timer);
      const rec = state.lastInput;
      state.lastInput = null;
      if (!state.running || !rec.el || !rec.el.isConnected) return;
      push({
        action: 'input',
        target: rec.target,
        value: rec.el.value || '',
        desc: '在「' + (rec.el.getAttribute('placeholder') || (rec.target[0] && rec.target[0].value) || '输入框') + '」输入'
      });
    }
  }

  /* 延迟验证元素仍存在后入栈（过滤脚本动态创建的临时元素，如 blob 下载 <a>） */
  function schedulePush(stepFactory, el) {
    setTimeout(() => {
      if (!state.running) return;
      if (el && !el.isConnected) return; // 临时元素已被移除 → 丢弃
      push(stepFactory());
    }, 300);
  }

  function isDownloadLike(el) {
    if (isDownloadAttr(el)) return true;
    // 链接文本带下载语义
    const t = W.textOf(el);
    if (/^(下载|导出|另存|download|export)/i.test(t)) return true;
    return false;
  }

  function isDownloadAttr(el) {
    if (!el) return false;
    if (el.hasAttribute('download')) return true;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (CONFIG.downloadExt.test(href)) return true;
    }
    return false;
  }

  /* ============ 事件监听 ============ */

  function onClick(e) {
    if (!state.running || state.busy) return;
    if (e.defaultPrevented) return;
    flushPendingInput(); // 先落盘输入，保持步骤顺序
    const el = e.target && e.target.closest ? e.target.closest('a,button,input[type=button],input[type=submit],[role=button],[onclick]') : e.target;
    if (!el) return;
    if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'password' || el.type === 'number')) return; // 输入类由 input 事件记录

    // 避免与 checkbox 的 click 重复（checkbox 由 change 记录）
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;

    if (isDownloadLike(el)) {
      schedulePush(() => ({ action: 'download', target: buildTarget(el), desc: '点击下载「' + W.textOf(el).slice(0, 30) + '」' }), el);
      return;
    }
    schedulePush(() => ({ action: 'click', target: buildTarget(el), desc: '点击「' + W.textOf(el).slice(0, 30) + '」' }), el);
  }

  function onInput(e) {
    if (!state.running) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      // 由 change 统一处理
      return;
    }
    if (el.tagName === 'SELECT') return;

    // 文件上传
    if (el.tagName === 'INPUT' && el.type === 'file') {
      onFileChange(el);
      return;
    }

    // 文本输入：防抖合并
    if (state.lastInput && state.lastInput.el === el) {
      clearTimeout(state.lastInput.timer);
    } else {
      state.lastInput = { el: el, target: buildTarget(el), start: Date.now() };
    }
    const rec = state.lastInput;
    rec.timer = setTimeout(() => {
      if (!state.running) return;
      push({
        action: 'input',
        target: rec.target,
        value: el.value || '',
        desc: '在「' + (el.getAttribute('placeholder') || rec.target[0] && rec.target[0].value || '输入框') + '」输入'
      });
      state.lastInput = null;
    }, CONFIG.inputDebounceMs);
  }

  function onChange(e) {
    if (!state.running) return;
    flushPendingInput(); // 先落盘输入，保持顺序
    const el = e.target;
    if (!el || el.nodeType !== 1) return;

    if (el.tagName === 'SELECT') {
      push({ action: 'select', target: buildTarget(el), value: el.value || '', desc: '选择下拉「' + (el.options[el.selectedIndex] || {}).text + '」' });
      return;
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      push({ action: 'checkbox', target: buildTarget(el), checked: !!el.checked, desc: (el.checked ? '勾选' : '取消勾选') + '「' + (el.labels && el.labels[0] ? W.deepText(el.labels[0]) : el.name) + '」' });
      return;
    }
    // file 由 onFileChange 处理
    if (el.tagName === 'INPUT' && el.type === 'file') return;
  }

  function onFileChange(el) {
    let names = [];
    try {
      names = Array.from(el.files || []).map((f) => f.name);
    } catch (e) {}
    push({
      action: 'upload',
      target: buildTarget(el),
      files: names,
      desc: '上传文件：' + (names.join('、') || '（请选择文件）')
    });
  }

  function onKeyDown(e) {
    if (!state.running) return;
    flushPendingInput();
    if (e.key === 'Enter') {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'file') {
        // Enter 提交：记录 key 步骤（回放时按 Enter）
        push({ action: 'key', key: 'Enter', target: buildTarget(el), desc: '在输入框按回车' });
      }
    }
  }

  /* ============ 导航监听 ============ */
  function patchHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      scheduleNav();
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      scheduleNav();
      return r;
    };
    window.addEventListener('hashchange', scheduleNav);
  }

  function scheduleNav() {
    if (!state.running) return;
    if (state.lastNav) clearTimeout(state.lastNav.timer);
    const prev = state.lastNav ? state.lastNav.url : null;
    state.lastNav = {
      timer: setTimeout(() => {
        const now = currentUrl();
        if (prev !== null && prev !== now) {
          push({ action: 'goto', url: now, desc: '跳转到 ' + now.slice(0, 60) });
        }
        state.lastNav = null;
      }, CONFIG.navDebounceMs),
      url: currentUrl()
    };
  }

  function currentUrl() {
    return location.href;
  }

  /* ============ 开始/停止 ============ */
  function start() {
    state.running = true;
    state.steps = [];
    patchHistory();
    updateHud();
    return { ok: true, steps: state.steps.length };
  }

  function stop() {
    state.running = false;
    if (state.lastInput && state.lastInput.timer) clearTimeout(state.lastInput.timer);
    if (state.lastNav && state.lastNav.timer) clearTimeout(state.lastNav.timer);
    removeHud();
    const steps = state.steps.slice();
    state.steps = [];
    return { ok: true, steps: steps, count: steps.length };
  }

  function attach() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  /* ============ 消息入口 ============ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'WBOT_REC') return;
    const ctl = msg.control;
    if (ctl === 'start') {
      attach();
      const r = start();
      sendResponse(r);
    } else if (ctl === 'stop') {
      const r = stop();
      sendResponse(r);
    } else if (ctl === 'status') {
      sendResponse({ running: state.running, count: state.steps.length });
    } else {
      sendResponse({ ok: false, error: 'unknown control' });
    }
  });
})();