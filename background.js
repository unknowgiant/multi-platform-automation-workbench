/*
 * background.js —— 多平台业务自动化工作台 · 主引擎（MV3 service worker）
 *
 * 职责：
 *  1. 平台配置 / 任务 / 日志的存储管理（chrome.storage.local）
 *  2. 录制会话控制（注入 recorder.js → 收集步骤）
 *  3. 回放任务调度（注入 player.js → 断点续跑 → 完成/失败状态）
 *  4. CDP 文件上传（chrome.debugger + DOM.setFileInputFiles）
 *  5. 下载自动归档（chrome.downloads.onDeterminingFilename → 平台子目录）
 *  6. 定时轮询（chrome.alarms → 平台调度配置）
 */
importScripts('lib/dsl.js');

const K = {
  platforms: 'wbot_platforms_v1',
  settings: 'wbot_settings_v1',
  jobs: 'wbot_jobs_v1'
};

const jobs = new Map();          // jobId -> 内存态（含 tabId/nextIndex）
const platformCache = new Map(); // platformId -> platform（供下载归档同步使用）
let settings = { downloadRoot: '' };
let panelPorts = new Set();      // 面板长连接

/* ================= 存储工具 ================= */

async function storeGet(key, def) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? def : r[key];
}
async function storeSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getPlatforms() { return storeGet(K.platforms, []); }
async function setPlatforms(list) { await storeSet(K.platforms, list); }
async function getSettings() {
  settings = await storeGet(K.settings, { downloadRoot: '' });
  return settings;
}
async function setSettings(s) { settings = s; await storeSet(K.settings, s); }

/* ================= 任务持久化 + 面板通知 ================= */

async function saveJob(job) {
  const list = await storeGet(K.jobs, []);
  const i = list.findIndex((x) => x.id === job.id);
  if (i >= 0) list[i] = job; else list.unshift(job);
  await storeSet(K.jobs, list.slice(0, 200));
  notifyPanel({ type: 'job', job });
}

function notifyPanel(payload) {
  for (const port of panelPorts) {
    try { port.postMessage(payload); } catch (e) {}
  }
}

function pushLog(job, text) {
  if (!job.log) job.log = [];
  job.log.push({ t: Date.now(), text });
  if (job.log.length > 500) job.log = job.log.slice(-500);
}

/* ================= 注入工具 ================= */

const INJECT_FILES = ['lib/selector.js'];

async function injectScripts(tabId, files) {
  await chrome.scripting.executeScript({ target: { tabId }, files: files });
}

async function recvTab(platform) {
  const base = new URL(platform.url).origin;
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => t.url && t.url.indexOf(base) === 0);
  if (hit) return hit.id;
  const t = await chrome.tabs.create({ url: platform.url, active: false });
  return t.id;
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) { clearInterval(timer); return resolve(false); }
        if (t.status === 'complete') { clearInterval(timer); return resolve(true); }
        if (Date.now() - t0 > timeoutMs) { clearInterval(timer); return resolve(false); }
      });
    }, 300);
  });
}

/* ================= 录制控制 ================= */

async function startRecording(tabId) {
  try {
    await injectScripts(tabId, INJECT_FILES);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder.js'] });
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'WBOT_REC', control: 'start' });
    return { ok: true, resp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function stopRecording(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'WBOT_REC', control: 'stop' });
    if (!resp || !resp.ok) return { ok: false, error: '未在录制状态' };
    return { ok: true, steps: resp.steps, count: resp.count };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ================= 回放任务 ================= */

async function runJob(platform, flowKey, opts) {
  const flow = platform.flows[flowKey];
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) {
    return { ok: false, error: '流程「' + flowKey + '」为空或不存在' };
  }
  const o = opts || {};
  const job = {
    id: 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    platformId: platform.id,
    platformName: platform.name,
    flowKey: flowKey,
    flowName: flow.name || flowKey,
    status: 'queued',
    progress: 0,
    total: flow.steps.length,
    index: 0,
    log: [],
    started: Date.now(),
    finished: null,
    tabId: null,
    nextIndex: 0,
    error: ''
  };
  platformCache.set(platform.id, platform);
  jobs.set(job.id, job);
  await saveJob(job);

  const exec = async (fromIndex) => {
    job.status = 'running';
    if (!job.tabId) job.tabId = await recvTab(platform);
    const tabId = job.tabId;
    if (!fromIndex) await waitTabComplete(tabId, 30000);
    try {
      await injectScripts(tabId, INJECT_FILES);
      await chrome.scripting.executeScript({ target: { tabId }, files: ['player.js'] });
    } catch (e) {
      return failJob(job, '脚本注入失败: ' + e.message);
    }
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'WBOT_PLAY', control: 'run',
      config: { steps: flow.steps, stepTimeout: o.stepTimeout || 15000, skippedOnError: o.skippedOnError !== false },
      fromIndex: fromIndex || 0
    }).catch((e) => ({ ok: false, error: e.message }));

    if (resp && resp.navigated) {
      job.nextIndex = resp.nextIndex;
      job.status = 'waiting';
      await saveJob(job);
      return;
    }
    if (resp && resp.ok) return finishJob(job);
    if (resp && !resp.ok) return failJob(job, resp.error || '执行失败');
    failJob(job, '执行器无响应');
  };

  await exec(0);
  return { ok: true, jobId: job.id };
}

function finishJob(job) {
  job.status = 'done'; job.progress = 100; job.finished = Date.now();
  return saveJob(job);
}
function failJob(job, error) {
  job.status = 'error'; job.error = error; job.finished = Date.now();
  pushLog(job, '❌ ' + error);
  return saveJob(job);
}

/* ================= 导航断点续跑 ================= */

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const job = findJobByTab(tabId);
  if (!job || job.status !== 'waiting') return;
  resumeJob(job);
});

function findJobByTab(tabId) {
  for (const job of jobs.values()) if (job.tabId === tabId) return job;
  return null;
}

async function resumeJob(job) {
  const platform = (await getPlatforms()).find((p) => p.id === job.platformId);
  const flow = platform && platform.flows[job.flowKey];
  if (!platform || !flow) return failJob(job, '平台或流程已不存在');
  const from = job.nextIndex || job.index;
  job.status = 'running';
  job.index = from;
  await saveJob(job);
  try {
    await injectScripts(job.tabId, INJECT_FILES);
    await chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['player.js'] });
    const resp = await chrome.tabs.sendMessage(job.tabId, {
      type: 'WBOT_PLAY', control: 'run',
      config: { steps: flow.steps, stepTimeout: 15000, skippedOnError: true },
      fromIndex: from
    }).catch((e) => ({ ok: false, error: e.message }));
    if (resp && resp.navigated) {
      job.nextIndex = resp.nextIndex;
      job.status = 'waiting';
      return saveJob(job);
    }
    if (resp && resp.ok) return finishJob(job);
    if (resp && !resp.ok) return failJob(job, resp.error);
    failJob(job, '断点续跑无响应');
  } catch (e) {
    failJob(job, '断点续跑失败: ' + e.message);
  }
}

/* ================= 消息路由（player 进度 / 上传 / 录制步骤 / 面板指令） ================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'WBOT_PLAY_PROGRESS') { handleProgress(msg, sender); return; }
  if (msg && msg.type === 'WBOT_PLAY_UPLOAD') { handleUpload(msg, sender).then(sendResponse); return true; }
  if (msg && msg.type === 'WBOT_REC_STEP') { notifyPanel({ type: 'recStep', step: msg.step }); return; }
  if (msg && msg.type === 'WBOT_MAIN') { handleMain(msg).then(sendResponse); return true; }
});

async function handleProgress(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const job = tabId ? findJobByTab(tabId) : null;
  notifyPanel({ type: 'progress', payload: msg, tabId });
  if (!job) return;

  if (msg.status === 'start') {
    job.progress = 0;
    pushLog(job, '▶ 开始执行，共 ' + job.total + ' 步' + (msg.resumeFrom ? '（断点续跑 第' + (msg.resumeFrom + 1) + '步）' : ''));
  } else if (msg.status === 'step') {
    job.index = msg.index;
    job.progress = Math.round(((msg.index - 1) / job.total) * 100);
    pushLog(job, '第' + msg.index + '步：' + (msg.desc || msg.id));
  } else if (msg.status === 'pass') {
    job.progress = Math.round((msg.index / job.total) * 100);
    pushLog(job, '✓ 完成（' + msg.index + '/' + job.total + '）');
  } else if (msg.status === 'fail') {
    pushLog(job, '✗ 失败：' + (msg.error || '') + (msg.snapshot && msg.snapshot.url ? ' @ ' + msg.snapshot.url : ''));
  } else if (msg.status === 'nav') {
    job.nextIndex = msg.nextIndex;
    job.status = 'waiting';
    pushLog(job, '↪ 页面跳转，等待加载后从第 ' + (msg.nextIndex + 1) + ' 步继续');
  } else if (msg.status === 'end') {
    job.progress = msg.ok ? 100 : job.progress;
    job.status = msg.ok ? 'done' : 'done'; // 跳过失败也视为完成，error 明细在日志
    job.finished = Date.now();
    pushLog(job, msg.ok ? '✅ 流程执行完成' : '⚠️ 流程结束（失败步骤已跳过）');
  }
  await saveJob(job);
}

/* ================= CDP 文件上传 ================= */

async function handleUpload(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return { ok: false, error: '无法确定页面' };

  const job = findJobByTab(tabId);
  const platform = job ? (await getPlatforms()).find((p) => p.id === job.platformId) : null;
  const uploadDir = platform && platform.uploadDir ? platform.uploadDir : '';
  const files = (msg.files || []).map((f) => {
    const base = String(f).split(/[\\/]/).pop();
    return uploadDir ? uploadDir.replace(/[\\/]$/, '') + '\\' + base : base;
  });

  // 直接尝试 CDP 上传；失败（文件不存在 / 无权限 / DevTools 占用）自动降级 MANUAL
  return attachFilesToPage(tabId, files);
}

async function attachFilesToPage(tabId, files) {
  const dbg = chrome.debugger;
  let attached = false;
  try {
    await dbg.attach({ tabId }, '1.3');
    attached = true;
    await dbg.sendCommand({ tabId }, 'DOM.enable');
    const doc = await dbg.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1 });
    const q = await dbg.sendCommand({ tabId }, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]'
    });
    if (!q.nodeId) return { ok: false, mode: 'MANUAL', error: '未找到 file input' };
    await dbg.sendCommand({ tabId }, 'DOM.setFileInputFiles', { nodeId: q.nodeId, files });
    return { ok: true };
  } catch (e) {
    return { ok: false, mode: 'MANUAL', error: 'CDP 上传失败: ' + e.message };
  } finally {
    if (attached) {
      try { await dbg.detach({ tabId }); } catch (e) {}
    }
  }
}

/* ================= 下载自动归档 ================= */

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const job = findRunningJob();
  if (!job) return;
  const platform = platformCache.get(job.platformId);
  if (!platform || !platform.downloadDir) return;
  const dir = platform.downloadDir.replace(/[\\/]$/, '');
  const name = item.filename.split(/[\\/]/).pop();
  // suggest 路径为相对默认下载目录的子路径（Chrome API 限制）
  const rel = dir.replace(/^[a-zA-Z]:\\/, '').replace(/\\/g, '/');
  suggest({ filename: rel + '/' + name, conflict_action: 'uniquify' });
});

function findRunningJob() {
  for (const job of jobs.values()) {
    if (job.status === 'running' || job.status === 'waiting') return job;
  }
  return null;
}

/* ================= 平台配置 API ================= */

async function handleMain(msg) {
  const action = msg.action;
  try {
    switch (action) {
      case 'listPlatforms': {
        const list = await getPlatforms();
        for (const p of list) platformCache.set(p.id, p);
        return { ok: true, platforms: list };
      }
      case 'savePlatform': {
        const list = await getPlatforms();
        const p = msg.platform;
        if (!p.id) p.id = 'p-' + Date.now().toString(36);
        const i = list.findIndex((x) => x.id === p.id);
        if (i >= 0) list[i] = p; else list.push(p);
        await setPlatforms(list);
        platformCache.set(p.id, p);
        syncAlarms();
        return { ok: true, platform: p };
      }
      case 'deletePlatform': {
        const list = (await getPlatforms()).filter((x) => x.id !== msg.id);
        await setPlatforms(list);
        platformCache.delete(msg.id);
        syncAlarms();
        return { ok: true };
      }
      case 'startRecording': {
        return startRecording(msg.tabId);
      }
      case 'stopRecording': {
        return stopRecording(msg.tabId);
      }
      case 'runFlow': {
        const list = await getPlatforms();
        const p = list.find((x) => x.id === msg.platformId);
        if (!p) return { ok: false, error: '平台不存在' };
        const job = await runJob(p, msg.flowKey, msg.opts || {});
        return { ok: true, jobId: job.id };
      }
      case 'stopJob': {
        const job = findJobById(msg.jobId);
        if (!job) return { ok: false, error: '任务不存在' };
        job.status = 'stopped'; job.finished = Date.now();
        pushLog(job, '⏹ 任务已手动停止');
        await saveJob(job);
        if (job.tabId) {
          try { await chrome.tabs.sendMessage(job.tabId, { type: 'WBOT_PLAY', control: 'stop' }); } catch (e) {}
        }
        return { ok: true };
      }
      case 'listJobs': {
        const list = await storeGet(K.jobs, []);
        return { ok: true, jobs: list.slice(0, msg.limit || 100) };
      }
      case 'getSettings': {
        const s = await getSettings();
        return { ok: true, settings: s };
      }
      case 'saveSettings': {
        await setSettings(msg.settings);
        syncAlarms();
        return { ok: true, settings: settings };
      }
      default:
        return { ok: false, error: '未知指令 ' + action };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function findJobById(id) {
  for (const job of jobs.values()) if (job.id === id) return job;
  return null;
}

/* ================= 定时轮询调度 ================= */

async function syncAlarms() {
  await chrome.alarms.clearAll();
  const list = await getPlatforms();
  for (const p of list) {
    const s = p.schedule;
    if (s && s.enabled && s.intervalMinutes > 0) {
      chrome.alarms.create('wbot-' + p.id, { periodInMinutes: s.intervalMinutes });
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name || alarm.name.indexOf('wbot-') !== 0) return;
  const platformId = alarm.name.slice(5);
  const list = await getPlatforms();
  const p = list.find((x) => x.id === platformId);
  if (!p || !p.schedule || !p.schedule.enabled) return;
  const flowKey = p.schedule.flow || 'download';
  const flow = p.flows[flowKey];
  if (!flow || !flow.steps || !flow.steps.length) return;
  await runJob(p, flowKey, {});
});

/* ================= 面板连接 ================= */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'wbot-panel') {
    panelPorts.add(port);
    port.onDisconnect.addListener(() => panelPorts.delete(port));
  }
});

/* ================= 初始化 ================= */

async function init() {
  await getSettings();
  // 预热平台缓存，供下载归档使用
  const list = await getPlatforms();
  for (const p of list) platformCache.set(p.id, p);
  await syncAlarms();
}

chrome.runtime.onInstalled.addListener(init);
init();