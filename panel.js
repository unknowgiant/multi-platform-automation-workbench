/* ============================================================
 * panel.js —— 控制面板逻辑
 * 平台管理 / 流程录制 / 任务执行 / 任务日志 / 设置
 * ============================================================ */
'use strict';

const DSL = window.__WBOT_DSL__;
let platforms = [];
let recState = null; // { platformId, flowKey, tabId, running }
let jobsCache = [];
let port = null;

/* ============ 基础 ============ */

function $(id) { return document.getElementById(id); }

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function callMain(msg) {
  try {
    const r = await chrome.runtime.sendMessage(Object.assign({ type: 'WBOT_MAIN' }, msg));
    return r || { ok: false, error: '无响应' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FLOW_NAME = { download: '下载流程', upload: '上传流程', custom: '自定义流程' };
const ST_LABEL = { queued: '排队中', running: '执行中', waiting: '等待导航', done: '已完成', error: '失败', stopped: '已停止' };
const ST_CLS = { queued: 'st-queued', running: 'st-running', waiting: 'st-waiting', done: 'st-done', error: 'st-error', stopped: 'st-stopped' };

/* ============ 平台渲染 ============ */

function stepsCount(p, key) {
  const f = p.flows && p.flows[key];
  return f && Array.isArray(f.steps) ? f.steps.length : 0;
}

async function loadPlatforms() {
  const r = await callMain({ action: 'listPlatforms' });
  if (r.ok) platforms = r.platforms;
  renderPlatforms();
  return r;
}

function renderPlatforms() {
  const box = $('platformList');
  if (!platforms.length) {
    box.innerHTML = '<div class="empty"><div class="icon">📋</div><p>还没有平台<br>点击右上角「＋ 新建平台」开始</p></div>';
    return;
  }
  box.innerHTML = platforms.map((p) => {
    const schedOn = p.schedule && p.schedule.enabled;
    const dl = stepsCount(p, 'download');
    const up = stepsCount(p, 'upload');
    const cu = stepsCount(p, 'custom');
    return '<div class="platform">' +
      '<div class="p-head"><div><div class="p-name">' + esc(p.name) + '</div>' +
      '<div class="p-url">' + esc(p.url || '(未设入口地址)') + '</div></div></div>' +
      '<div class="p-badges">' +
        (schedOn ? '<span class="badge sched-on">⏰ 定时轮询 ' + (p.schedule.intervalMinutes || 30) + ' 分钟</span>' : '') +
        (dl ? '<span class="badge flow">下载 ' + dl + '步</span>' : '') +
        (up ? '<span class="badge flow">上传 ' + up + '步</span>' : '') +
        (cu ? '<span class="badge flow">自定义 ' + cu + '步</span>' : '') +
      '</div>' +
      '<div class="p-actions">' +
        (dl ? '<button class="btn btn-sm btn-primary" onclick="runFlow(\'' + esc(p.id) + '\',\'download\')">▶ 执行下载</button>' : '<button class="btn btn-sm" onclick="startRec(\'' + esc(p.id) + '\',\'download\')">● 录制下载</button>') +
        (up ? '<button class="btn btn-sm btn-primary" onclick="runFlow(\'' + esc(p.id) + '\',\'upload\')">▶ 执行上传</button>' : '<button class="btn btn-sm" onclick="startRec(\'' + esc(p.id) + '\',\'upload\')">● 录制上传</button>') +
        (cu ? '<button class="btn btn-sm" onclick="runFlow(\'' + esc(p.id) + '\',\'custom\')">▶ 自定义</button>' : '') +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm" onclick="editPlatform(\'' + esc(p.id) + '\')">编辑</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deletePlatform(\'' + esc(p.id) + '\')">删除</button>' +
      '</div>' +
      '<div class="flow-row"><span class="f-name">下载流程</span><span class="f-steps">' + (dl ? dl + ' 步' : '未录制') + '</span>' +
        '<span class="spacer"></span>' +
        (dl ? '<button class="btn btn-sm btn-ghost" onclick="showSteps(\'' + esc(p.id) + '\',\'download\')">查看</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="startRec(\'' + esc(p.id) + '\',\'download\')">重录</button>' : '') + '</div>' +
      '<div class="flow-row"><span class="f-name">上传流程</span><span class="f-steps">' + (up ? up + ' 步' : '未录制') + '</span>' +
        '<span class="spacer"></span>' +
        (up ? '<button class="btn btn-sm btn-ghost" onclick="showSteps(\'' + esc(p.id) + '\',\'upload\')">查看</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="startRec(\'' + esc(p.id) + '\',\'upload\')">重录</button>' : '') + '</div>' +
    '</div>';
  }).join('');
}

/* ============ 平台编辑 ============ */

function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

function openPlatformModal(p) {
  $('platformModalTitle').textContent = p ? '编辑平台' : '新建平台';
  $('fId').value = p ? p.id : '';
  $('fName').value = p ? p.name : '';
  $('fUrl').value = p ? p.url : '';
  $('fDlDir').value = p && p.downloadDir ? p.downloadDir : '';
  $('fUpDir').value = p && p.uploadDir ? p.uploadDir : '';
  $('fSchedOn').value = p && p.schedule && p.schedule.enabled ? '1' : '0';
  $('fSchedMin').value = p && p.schedule ? (p.schedule.intervalMinutes || 30) : 30;
  $('fSchedFlow').value = p && p.schedule && p.schedule.flow ? p.schedule.flow : 'download';
  openModal('platformMask');
}

function editPlatform(id) {
  const p = platforms.find((x) => x.id === id);
  if (p) openPlatformModal(p);
}

async function savePlatformFromForm() {
  const name = $('fName').value.trim();
  if (!name) { toast('请填写平台名称'); return; }
  const id = $('fId').value;
  const old = platforms.find((x) => x.id === id);
  const p = {
    id: id || '',
    name: name,
    url: $('fUrl').value.trim(),
    downloadDir: $('fDlDir').value.trim(),
    uploadDir: $('fUpDir').value.trim(),
    flows: old ? old.flows : {
      download: { name: '下载流程', steps: [] },
      upload: { name: '上传流程', steps: [] },
      custom: { name: '自定义流程', steps: [] }
    },
    schedule: {
      enabled: $('fSchedOn').value === '1',
      intervalMinutes: parseInt($('fSchedMin').value, 10) || 30,
      flow: $('fSchedFlow').value
    }
  };
  const r = await callMain({ action: 'savePlatform', platform: p });
  if (r.ok) { toast('平台已保存'); closeModal('platformMask'); await loadPlatforms(); }
  else toast('保存失败: ' + r.error);
}

function deletePlatform(id) {
  if (!confirm('确定删除平台吗？其录制的流程将一并删除。')) return;
  callMain({ action: 'deletePlatform', id: id }).then((r) => {
    if (r.ok) { toast('已删除'); loadPlatforms(); } else toast('删除失败: ' + r.error);
  });
}

/* ============ 录制 ============ */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function startRec(platformId, flowKey) {
  const platform = platforms.find((x) => x.id === platformId);
  recState = { platformId: platformId, flowKey: flowKey, tabId: null, running: false };
  $('recTitle').textContent = platform.name + ' · ' + FLOW_NAME[flowKey];
  $('recHint').innerHTML = '1. 确认目标页面已打开（在标签页中）<br>' +
    '2. 点击「开始录制」，随后在页面上 <b>正常操作一遍</b>（点击 / 输入 / 选择 / 上传 / 下载）<br>' +
    '3. 操作完成后回到本面板，点击「停止录制」生成步骤';
  $('btnRecStart').style.display = 'inline-block';
  $('btnRecStop').style.display = 'none';
  $('recStepsWrap').style.display = 'none';
  openModal('recMask');
}

async function beginRecording() {
  if (!recState) return;
  const tab = await getActiveTab();
  if (!tab) { toast('未找到活动标签页，请先打开目标网站'); return; }
  const r = await callMain({ action: 'startRecording', tabId: tab.id });
  if (!r.ok) { toast('录制启动失败: ' + r.error); return; }
  recState.tabId = tab.id;
  recState.running = true;
  $('recHint').innerHTML = '<span class="rec-dot"></span> 正在录制：<b>' + esc(tab.title || tab.url || '') + '</b><br>请切到该页面正常操作，完成后回来点「停止录制」。';
  $('btnRecStart').style.display = 'none';
  $('btnRecStop').style.display = 'inline-block';
  $('topState').textContent = '录制中…';
  $('topState').style.color = 'var(--red)';
}

async function stopRec() {
  if (!recState || !recState.running) return;
  const r = await callMain({ action: 'stopRecording', tabId: recState.tabId });
  if (!r.ok) { toast('停止录制失败: ' + r.error); return; }
  recState.running = false;
  $('btnRecStart').style.display = 'inline-block';
  $('btnRecStop').style.display = 'none';
  $('topState').textContent = '就绪';
  $('topState').style.color = '';
  const steps = (r.steps || []).map((s) => ({
    action: s.action, target: s.target, value: s.value, checked: s.checked,
    files: s.files, url: s.url, key: s.key, wait: s.wait, desc: s.desc
  }));
  $('recSteps').value = JSON.stringify(steps, null, 2);
  $('recStepsWrap').style.display = 'block';
  toast('已录制 ' + r.count + ' 步');
}

async function saveRec() {
  if (!recState) return;
  let steps = null;
  try { steps = JSON.parse($('recSteps').value || '[]'); } catch (e) { toast('步骤 JSON 格式错误'); return; }
  if (!Array.isArray(steps)) { toast('步骤必须是数组'); return; }
  const p = platforms.find((x) => x.id === recState.platformId);
  if (!p) { toast('平台不存在'); return; }
  p.flows[recState.flowKey] = { name: FLOW_NAMES[recState.flowKey], steps: steps };
  const r = await callMain({ action: 'savePlatform', platform: p });
  if (r.ok) {
    toast('流程已保存（' + steps.length + ' 步）');
    closeModal('recMask');
    await loadPlatforms();
    recState = null;
  } else toast('保存失败: ' + r.error);
}

function discardRec() {
  recState = null;
  closeModal('recMask');
  $('btnRecStart').style.display = 'inline-block';
  $('btnRecStop').style.display = 'none';
  $('recStepsWrap').style.display = 'none';
  $('topState').textContent = '就绪';
  $('topState').style.color = '';
}

/* ============ 执行 ============ */

async function runFlow(platformId, flowKey) {
  const r = await callMain({ action: 'runFlow', platformId: platformId, flowKey: flowKey });
  if (r.ok) { toast('任务已启动'); await loadJobs(); }
  else toast('启动失败: ' + r.error);
}

async function stopJob(jobId) {
  const r = await callMain({ action: 'stopJob', jobId: jobId });
  if (r.ok) toast('已停止');
  await loadJobs();
}

/* ============ 任务日志 ============ */

async function loadJobs() {
  const r = await callMain({ action: 'listJobs', limit: 30 });
  if (r.ok) { jobsCache = r.jobs; renderJobs(); }
}

function renderJobs() {
  const box = $('jobList');
  if (!jobsCache.length) {
    box.innerHTML = '<div class="empty"><div class="icon">📄</div><p>暂无任务记录<br>执行平台的下载/上传流程后，这里会显示执行进度与日志</p></div>';
    return;
  }
  box.innerHTML = jobsCache.map((j) => {
    const logs = (j.log || []).slice(-12).map((l) => '<div>· ' + esc(l.text) + '</div>').join('');
    const time = new Date(j.started).toLocaleString();
    return '<div class="job">' +
      '<div class="j-head"><span class="j-status ' + (ST_CLS[j.status] || 'st-queued') + '">' + (ST_LABEL[j.status] || j.status) + '</span>' +
      '<b>' + esc(j.platformName || '') + '</b> · ' + esc(j.flowName || j.flowKey) + '</div>' +
      '<div class="j-bar"><i style="width:' + (j.progress || 0) + '%"></i></div>' +
      '<div class="j-meta">' + time + ' · 进度 ' + (j.progress || 0) + '% · 第' + (j.index || 0) + '/' + (j.total || 0) + '步' +
        ((j.status === 'running' || j.status === 'waiting') ? ' <button class="btn btn-sm btn-danger" onclick="stopJob(\'' + j.id + '\')">停止</button>' : '') +
      '</div>' +
      (logs ? '<div class="j-log">' + logs + '</div>' : '') +
    '</div>';
  }).join('');
}

/* ============ 步骤查看 ============ */

function showSteps(platformId, flowKey) {
  const p = platforms.find((x) => x.id === platformId);
  const flow = p && p.flows && p.flows[flowKey];
  if (!flow || !flow.steps) return;
  const lines = flow.steps.map((s, i) => (i + 1) + '. ' + (DSL ? DSL.stepLabel(s) : s.action)).join('\n');
  alert('【' + p.name + ' · ' + FLOW_NAME[flowKey] + '】共 ' + flow.steps.length + ' 步\n\n' + lines);
}

/* ============ 设置 ============ */

async function openSettings() {
  const r = await callMain({ action: 'getSettings' });
  const s = r.ok ? r.settings : {};
  $('sDownloadRoot').value = s.downloadRoot || '';
  $('sTimeout').value = s.timeout || 15000;
  openModal('settingsMask');
}

async function saveSettings() {
  const s = {
    downloadRoot: $('sDownloadRoot').value.trim(),
    timeout: parseInt($('sTimeout').value, 10) || 15000
  };
  const r = await callMain({ action: 'saveSettings', settings: s });
  if (r.ok) { toast('设置已保存'); closeModal('settingsMask'); }
  else toast('保存失败: ' + r.error);
}

/* ============ 实时推送（进度 / 任务状态） ============ */

function connectPanel() {
  port = chrome.runtime.connect({ name: 'wbot-panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'job') {
      const i = jobsCache.findIndex((j) => j.id === msg.job.id);
      if (i >= 0) jobsCache[i] = msg.job; else jobsCache.unshift(msg.job);
      renderJobs();
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connectPanel, 1000));
}

/* ============ 事件绑定 ============ */

$('btnAddPlatform').addEventListener('click', () => openPlatformModal(null));
$('btnSavePlatform').addEventListener('click', savePlatformFromForm);
$('btnRecStart').addEventListener('click', beginRecording);
$('btnRecStop').addEventListener('click', stopRec);
$('btnRecDiscard').addEventListener('click', discardRec);
$('btnRecSave').addEventListener('click', saveRec);
$('btnJobs').addEventListener('click', () => { $('jobList').scrollIntoView({ behavior: 'smooth' }); loadJobs(); });
$('btnSettings').addEventListener('click', openSettings);
$('btnSaveSettings').addEventListener('click', saveSettings);

document.querySelectorAll('.mask').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
});

/* ============ 初始化 ============ */

(async function init() {
  await loadPlatforms();
  await loadJobs();
  connectPanel();
})();