/*
 * selector.js —— 多级选择器引擎（录制 + 回放共用）
 *
 * 职责：
 *  1. buildLocators(el)：为元素生成多级定位器（id → 语义属性 → 稳定class → 文本锚 → nth路径）
 *  2. locate(locators)：按定位器列表逐一尝试定位元素
 *  3. 配套 DOM 工具：可见性判断、文本匹配、输入框原生 setter、事件派发
 *
 * 以 window.__WBOT__ 命名空间挂载（content script 隔离世界内共享）。
 */
(function () {
  'use strict';
  if (window.__WBOT__) return;

  const W = (window.__WBOT__ = {});

  /* ================= 基础 DOM 工具 ================= */

  W.isVisible = function (el) {
    if (!el || !el.isConnected) return false;
    if (el.nodeType !== 1) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  };

  W.waitMs = function (ms) {
    return new Promise((res) => setTimeout(res, ms));
  };

  W.deepText = function (el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  };

  /* 稳定类名：过滤掉常见框架动态类、哈希类 */
  W.stableClasses = function (el) {
    const out = [];
    (el.classList || []).forEach((c) => {
      if (!c) return;
      if (c.length > 40) return;
      if (/^[a-z0-9]+_[a-z0-9]+$/i.test(c) && c.length > 20) return; // css-modules
      if (/^(ant|el|mui|ivu|ngx|_ng|sc-)[-_]?/.test(c)) return;
      if (/^\d/.test(c)) return;
      out.push(c);
    });
    return out.slice(0, 3);
  };

  function selectorFromId(el) {
    if (!el || !el.id) return null;
    const id = el.id;
    if (/^[\w\-\:]+$/.test(id)) return '#' + id;
    return null;
  }

  /* 生成 nth-of-type 路径（兜底，尽量短） */
  W.cssPath = function (el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        const s = '#' + node.id.replace(/"/g, '\\"');
        parts.unshift(s);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(node) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    const path = parts.join(' > ');
    return path.length > 200 ? null : path;
  };

  /* 语义文本摘要 */
  W.textOf = function (el) {
    const own = Array.prototype.filter
      .call(el.childNodes || [], (n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('');
    const t = (own || el.getAttribute('value') || el.getAttribute('placeholder') || W.deepText(el) || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 60 ? t.slice(0, 60) : t;
  };

  /* ================= 定位器生成 =================
   * 返回数组，优先级从高到低。每项 { kind, value, primary }
   * kinds: css / text
   */
  W.buildLocators = function (el) {
    if (!el || el.nodeType !== 1) return [];
    const out = [];
    const tag = el.tagName.toLowerCase();

    const idSel = selectorFromId(el);
    if (idSel) out.push({ kind: 'css', value: idSel, primary: true });

    const attrs = ['name', 'placeholder', 'aria-label', 'data-testid', 'data-test', 'title'];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && v.trim()) {
        const sel = tag + '[' + a + '="' + v.replace(/"/g, '\\"') + '"]';
        out.push({ kind: 'css', value: sel, primary: true });
      }
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const lab = el.closest('label');
      if (lab) {
        const t = W.deepText(lab);
        if (t) out.push({ kind: 'text', value: t, primary: false });
      }
    }

    const st = W.stableClasses(el);
    if (st.length) out.push({ kind: 'css', value: tag + '.' + st.join('.') });

    const txt = W.textOf(el);
    if (txt && (tag === 'button' || tag === 'a' || tag === 'span' || tag === 'li' || tag === 'option')) {
      out.push({ kind: 'text', value: txt, primary: false });
    }

    const path = W.cssPath(el);
    if (path) out.push({ kind: 'css', value: path });

    const seen = new Set();
    const unique = [];
    for (const l of out) {
      const k = l.kind + '|' + l.value;
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(l);
      }
    }
    return unique.slice(0, 6);
  };

  /* ================= 定位执行 ================= */

  function queryByText(text, root) {
    const doc = root || document;
    const nodes = doc.querySelectorAll(
      'button, a, span, li, option, label, div[role=button], input[type=submit], input[type=button]'
    );
    for (const n of nodes) {
      const t = W.textOf(n);
      if (t && (t === text || t.indexOf(text) !== -1 || text.indexOf(t) !== -1)) return n;
    }
    return null;
  }

  /* 按定位器数组定位，返回第一个命中的元素 */
  W.locate = function (locators, root) {
    if (!Array.isArray(locators)) return null;
    const doc = root || document;
    for (const loc of locators) {
      let el = null;
      if (loc.kind === 'css') {
        try {
          el = doc.querySelector(loc.value);
        } catch (e) { el = null; }
      } else if (loc.kind === 'text') {
        el = queryByText(loc.value, doc);
      }
      if (el) return el;
    }
    return null;
  };

  /* 等待定位器命中，超时 reject */
  W.waitForLocators = function (locators, timeoutMs) {
    const limit = timeoutMs || 15000;
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function tick() {
        const el = W.locate(locators);
        if (el) return resolve(el);
        if (Date.now() - t0 > limit) {
          return reject(new Error('等待元素超时: ' + JSON.stringify(locators && locators[0])));
        }
        setTimeout(tick, 250);
      })();
    });
  };

  /* 元素快照（失败诊断） */
  W.snapshot = function (el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className : '',
      text: W.textOf(el).slice(0, 40),
      url: location.href.slice(0, 200),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  };

  /* 原生 setter 赋值 + 事件派发（兼容 Vue/React） */
  W.setInputValue = function (el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  W.setSelectValue = function (el, value) {
    el.value = String(value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  W.clickElement = function (el) {
    if (typeof el.click === 'function') {
      try {
        el.click();
        return;
      } catch (e) { /* fallthrough */ }
    }
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
    el.dispatchEvent(ev);
  };

  W.setCheckbox = function (el, checked) {
    if (el.checked !== !!checked) {
      el.checked = !!checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('click', { bubbles: true }));
    }
  };

  /* 唯一 id（录制步骤用） */
  W.uid = function (p) {
    return (p || 's') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  };
})();