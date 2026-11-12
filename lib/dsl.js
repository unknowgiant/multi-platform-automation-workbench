/*
 * dsl.js —— 流程步骤 DSL：定义、校验、模板渲染、人类可读标签
 * 兼容：background service worker（importScripts）与 panel 页面（<script>）
 */
(function (root) {
  'use strict';
  if (root.__WBOT_DSL__) return;

  /* 步骤动作类型定义 */
  const ACTIONS = {
    goto:     { label: '打开页面',   fields: ['url'] },
    click:    { label: '点击',       fields: ['target'] },
    input:    { label: '输入',       fields: ['target', 'value'] },
    select:   { label: '下拉选择',   fields: ['target', 'value'] },
    checkbox: { label: '勾选',       fields: ['target', 'checked'] },
    upload:   { label: '上传文件',   fields: ['target', 'files'] },
    download: { label: '触发下载',   fields: ['target'] },
    wait:     { label: '等待',       fields: ['type', 'value'] },
    assert:   { label: '校验',       fields: ['type', 'value'] },
    key:      { label: '按键',       fields: ['key'] }
  };

  /* 变量模板渲染：{{name}} 或 ${name}，来自 vars 上下文 */
  function renderTemplate(str, vars) {
    if (typeof str !== 'string') return str;
    const v = vars || {};
    return str.replace(/\{\{\s*([\w.\-]+)\s*\}\}|\$\{([\w.\-]+)\}/g, function (m, a, b) {
      const key = a || b;
      const parts = key.split('.');
      let cur = v;
      for (const p of parts) {
        if (cur == null) return m;
        cur = cur[p];
      }
      return cur == null ? m : String(cur);
    });
  }

  /* 步骤规范化：补默认字段、校验必填 */
  function normalizeStep(step, idx) {
    const s = Object.assign({}, step);
    if (!s.id) s.id = 's' + (idx + 1);
    if (!s.action || !ACTIONS[s.action]) {
      throw new Error('第' + (idx + 1) + '步：未知动作 ' + (s.action || '(空)'));
    }
    if (s.target) {
      // 兼容两种 target 形态：字符串（css）或定位器数组
      if (typeof s.target === 'string') {
        s.target = [{ kind: 'css', value: s.target, primary: true }];
      }
      if (!Array.isArray(s.target)) s.target = [s.target];
    }
    if (!s.wait) s.wait = null;
    return s;
  }

  function normalizeSteps(steps) {
    if (!Array.isArray(steps)) throw new Error('步骤必须是数组');
    return steps.map(normalizeStep);
  }

  /* 人类可读描述 */
  function stepLabel(step) {
    const def = ACTIONS[step.action] || { label: step.action };
    const t = step.target && step.target[0] ? step.target[0].value : '';
    switch (step.action) {
      case 'goto': return '打开 ' + step.url;
      case 'click': return '点击「' + t + '」';
      case 'input': return '在「' + t + '」输入 ' + step.value;
      case 'select': return '选择「' + t + '」为 ' + step.value;
      case 'checkbox': return (step.checked ? '勾选' : '取消勾选') + '「' + t + '」';
      case 'upload': return '上传文件到「' + t + '」';
      case 'download': return '触发下载（' + t + '）';
      case 'wait':
        return step.type === 'time' ? '等待 ' + step.value + ' 毫秒' : '等待 ' + step.type + ':' + step.value;
      case 'assert': return '校验 ' + step.type + ':' + step.value;
      case 'key': return '按键 ' + step.key;
      default: return def.label;
    }
  }

  root.__WBOT_DSL__ = {
    ACTIONS,
    renderTemplate,
    normalizeSteps,
    stepLabel: stepToLabel,
    actionsLabel: ACTIONS
  };

  function stepToLabel(s) {
    return stepLabelSafe(s);
  }
  function stepLabelSafe(step) {
    try { return stepLabel(step); } catch (e) { return step.action; }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);