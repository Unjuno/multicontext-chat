import { workspaceStatusLabel as sharedWorkspaceLabel, memberStatusLabel as sharedMemberLabel } from './runtimeLabels.js';
import { pickDisplayedRun, followedRunState } from './follow-run.js';
import { selectActivityEvents } from './activity-feed.js';

let currentId = null;
let timer = null;
let agents = [];
let refreshController = null;
let workspaceSearchTimer = null;
const openEditors = new Set();
let workspaceSearchQuery = '';
let workspaceListExpanded = false;
const workspaceFilterValues = new Set(['all', 'RUNNING', 'PENDING', 'BLOCKED', 'SETTLED', 'ARCHIVED']);
const savedWorkspaceFilter = localStorage.getItem('mcc_workspace_filter');
let workspaceStatusFilter = workspaceFilterValues.has(savedWorkspaceFilter) ? savedWorkspaceFilter : 'all';
let workspaceSort = localStorage.getItem('mcc_workspace_sort') === 'name' ? 'name' : 'recent';
let pinnedWorkspaceIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('mcc_pinned_workspaces') || '[]')); } catch { return new Set(); }
})();

const savedTheme = localStorage.getItem('mcc_theme');
if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.dataset.theme = savedTheme;
const themeToggle = document.getElementById('themeToggle');
function updateThemeToggle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeToggle?.setAttribute('aria-label', dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
  themeToggle?.setAttribute('title', dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
  if (themeToggle) themeToggle.textContent = dark ? '☀' : '☾';
}
themeToggle?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('mcc_theme', next);
  updateThemeToggle();
});
updateThemeToggle();
const helpToggle = document.getElementById('helpToggle');
const desktopSettings = document.getElementById('desktopSettings');
desktopSettings?.addEventListener('click', () => {
  if (isWorkspaceDirty() && currentId && !confirm('未保存の変更があります。設定画面へ移動しますか？')) return;
  if (!window.__TAURI__ && !window.__TAURI_INTERNALS__) {
    toast('デスクトップアプリでのみ設定を開けます', 'warn');
    return;
  }
  window.location.href = 'desktop-startup.html?settings=1';
});
const helpDialog = document.getElementById('helpDialog');
const helpClose = document.getElementById('helpClose');
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const shortcutModifier = isMac ? '⌘' : 'Ctrl+';
document.querySelectorAll('[data-modifier-shortcut]').forEach((key) => {
  const shortcut = key.dataset.modifierShortcut;
  key.textContent = shortcut === 'Enter' ? `${shortcutModifier}↵` : `${shortcutModifier}${shortcut}`;
});
function closeHelp() {
  if (helpDialog?.close) helpDialog.close(); else helpDialog?.removeAttribute('open');
  helpToggle?.setAttribute('aria-expanded', 'false');
  helpToggle?.focus();
}
helpToggle?.addEventListener('click', () => {
  if (typeof helpDialog?.showModal === 'function') helpDialog.showModal(); else helpDialog?.setAttribute('open', '');
  helpToggle?.setAttribute('aria-expanded', 'true');
  helpClose?.focus();
});
helpClose?.addEventListener('click', closeHelp);
helpDialog?.addEventListener('click', (event) => { if (event.target === helpDialog) closeHelp(); });
helpDialog?.addEventListener('close', () => {
  helpToggle?.setAttribute('aria-expanded', 'false');
  helpToggle?.focus();
});
let lastWorkspace = null; // server snapshot for dirty checks

function agentNameForId(id) {
  if (!id) return '';
  const found = agents.find(a => String(a.id) === String(id));
  return found ? String(found.name || found.id) : String(id);
}
function workspaceActivityTimestamp(workspace) {
  return workspace?.updatedAt || workspace?.createdAt || '';
}
function workspaceUpdatedLabel(workspace) {
  const time = Date.parse(workspaceActivityTimestamp(workspace));
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}日前`;
  return new Date(time).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}
function resetWorkspaceViewState() {
  workspaceSearchQuery = '';
  workspaceListExpanded = false;
  clearTimeout(workspaceSearchTimer);
  workspaceStatusFilter = 'all';
  workspaceSort = 'recent';
  if (workspaceSearch) workspaceSearch.value = '';
  if (workspaceFilter) workspaceFilter.value = 'all';
  if (workspaceSortSelect) workspaceSortSelect.value = 'recent';
  localStorage.setItem('mcc_workspace_filter', 'all');
  localStorage.setItem('mcc_workspace_sort', 'recent');
}
function agentOptionsHtml(selectedId, includeDefault) {
  const opts = [];
  if (includeDefault) {
    const defLabel = 'ワークスペース既定を使用';
    opts.push(`<option value="" ${!selectedId ? 'selected' : ''}>${esc(defLabel)}</option>`);
  } else {
    const label = agents.length > 1 ? '未設定 — 選択してください' : '未設定 (自動)';
    opts.push(`<option value="" ${!selectedId ? 'selected' : ''}>${esc(label)}</option>`);
  }
  for (const a of agents) {
    const sel = String(a.id) === String(selectedId) ? 'selected' : '';
    const label = `${esc(a.name || a.id)}${a.provider ? ` · ${esc(a.provider)}` : ''}`;
    opts.push(`<option value="${esc(a.id)}" ${sel}>${label}</option>`);
  }
  if (selectedId && !agents.some(a => String(a.id) === String(selectedId))) {
    opts.push(`<option value="${esc(selectedId)}" selected>利用不可: ${esc(selectedId)}</option>`);
  }
  return opts.join('');
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const token = () => localStorage.getItem('mcc_token') || '';

// ── Toast ──────────────────────────────────────────────────────────
function toast(message, kind = '') {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.innerHTML = `<span>${esc(message)}</span><button class="sm">閉じる</button>`;
  const btn = $('button', el);
  btn.onclick = () => dismiss();
  stack.appendChild(el);
  let t = setTimeout(dismiss, 3200);
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', () => { t = setTimeout(dismiss, 1800); });
  function dismiss() {
    el.style.animation = 'toastOut 0.18s ease forwards';
    setTimeout(() => el.remove(), 180);
    clearTimeout(t);
  }
}

function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled || btn.classList.contains('is-busy')) return Promise.resolve();
  const prev = btn.textContent;
  btn.classList.add('is-busy');
  btn.disabled = true;
  const done = () => { btn.classList.remove('is-busy'); btn.disabled = false; btn.textContent = prev; };
  return Promise.resolve(fn()).then((v) => { done(); return v; }, (e) => { done(); throw e; });
}

function autoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    return copied;
  }
}

async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const apiBase = localStorage.getItem('mcc_api_base') || '';
  const requestUrl = /^https?:\/\//i.test(url) ? url : `${apiBase}${url}`;
  const response = await fetch(requestUrl, { ...options, headers });
  if (response.status === 401) {
    $('#tokenDialog').showModal();
    throw new Error('Unauthorized');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorValue = data.error;
    const rawMessage = typeof errorValue === 'object' && errorValue !== null
      ? (errorValue.message || errorValue.detail || `HTTP ${response.status}`)
      : (errorValue || `HTTP ${response.status}`);
    const message = {
      'Prompt is required': 'プロンプトを入力してください',
      'Unauthorized': '認証が必要です。接続設定を確認してください',
      'Invalid idempotency_key: use 1-64 chars of [A-Za-z0-9_-]': '再送識別キーの形式が不正です',
      'Idempotency key was already used for a different prompt': '同じ再送識別キーが別のプロンプトに使われています',
    }[String(rawMessage)] || rawMessage;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function refreshHealth() {
  try {
    const health = await request('/api/health');
    $('#health').textContent = `LibreChat ${health.librechat.mode} · ${health.librechat.agents} エージェント · ${health.librechat.latencyMs}ms`;
    $('#health').title = `MultiContext v${health.version || '不明'} · mode=${health.librechat.mode} agents=${health.librechat.agents} latency=${health.librechat.latencyMs}ms`;
  } catch (error) {
    $('#health').textContent = `LibreChat 接続不可 · ${error.message}`;
    $('#health').title = error.message;
  }
}

// ── Runtime Status (persistent AI stack indicator) ───────────────
let runtimeStatuses = [];
let runtimePollTimer = null;
let runtimePolling = false;
let runtimeAbort = null;
let runtimeVersion = null;

function getTauriInvoke() {
  try {
    const t = window.__TAURI__;
    if (t && t.core && t.core.invoke) return t.core.invoke;
    if (t && t.invoke) return t.invoke;
    const internals = window.__TAURI_INTERNALS__;
    if (internals && internals.invoke) return internals.invoke;
  } catch {}
  return null;
}

function renderRuntime(statuses) {
  const btn = $('#runtimeStatus');
  const dialogDetail = $('#runtimeDetail');
  if (!btn) return;
  // Use DesktopUI helpers if available (loaded via desktop-ui.js in Tauri, fallback inline)
  const UI = window.DesktopUI || {
    serviceDisplayLabel: (n,s) => s,
    aggregateStatus: (list) => {
      if (!list || !list.length) return { text: 'AI Stack ● 確認中', cls: 'checking' };
      const states = list.map(x=>String(x.state).toLowerCase());
      const core = list.filter(x => ['モデル', 'LibreChat', 'MultiContext'].includes(x.name));
      if (core.length === 3 && core.every(x => String(x.state).toLowerCase() === 'ready') && !states.includes('error')) {
        return { text: 'AI Stack ● 準備完了', cls: 'ready' };
      }
      if (states.every(s=>s==='ready')) return { text: 'AI Stack ● 準備完了', cls: 'ready' };
      if (states.some(s=>s==='error')) return { text: 'AI Stack ● 要確認', cls: 'error' };
      if (states.some(s=>s==='checking')) return { text: 'AI Stack ● 一部確認中', cls: 'checking' };
      return { text: 'AI Stack ● 起動中', cls: 'starting' };
    },
    ownershipText: () => '',
    dotClassForState: (s) => String(s).toLowerCase(),
  };
  const agg = UI.aggregateStatus(statuses);
  btn.className = `runtime-compact ${agg.cls}`;
  btn.querySelector('.runtime-text').textContent = agg.text;
  btn.setAttribute('aria-label', agg.text);
  // Detail panel
  if (dialogDetail) {
    if (!statuses || !statuses.length) {
      dialogDetail.innerHTML = '<div class="small">確認中...</div>';
    } else {
      dialogDetail.innerHTML = statuses.map((s) => {
        const label = window.DesktopUI ? window.DesktopUI.serviceDisplayLabel(s.name, s.state) : String(s.state);
        const dotCls = window.DesktopUI ? window.DesktopUI.dotClassForState(s.state) : String(s.state).toLowerCase();
        const own = window.DesktopUI ? window.DesktopUI.ownershipText(s.ownership) : (s.ownership || '');
        const ownHtml = own ? `<span class="runtime-row-own">${esc(own)}</span>` : '';
        const msg = s.message ? esc(s.message) : '';
        return `<div class="runtime-row">
          <span class="runtime-row-name">${esc(s.name)}</span>
          <span class="runtime-row-meta">
            <span class="runtime-row-dot ${esc(dotCls)}" aria-hidden="true"></span>
            <span class="small" style="font-weight:600">${esc(label)}</span>
            ${msg ? `<span class="runtime-row-msg" title="${msg}">${msg}</span>` : ''}
            ${ownHtml}
          </span>
        </div>`;
      }).join('') + (runtimeVersion ? `<div class="runtime-version">接続先バージョン v${esc(runtimeVersion)}</div>` : '');
    }
  }
}

async function fetchAgentRuntimeEntry(signal) {
  try {
    const data = await request('/api/agents', { signal });
    const count = Array.isArray(data.agents) ? data.agents.length : 0;
    if (count > 0) return { name: 'LibreChat Agent', state: 'ready', message: '利用可能', ownership: null, attempt_id: 0 };
    return { name: 'LibreChat Agent', state: 'error', message: '未設定 — LibreChatでAgentを作成してください', ownership: null, attempt_id: 0 };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const msg = String(e.message || '');
    if (msg.includes('DISCOVERY_FAILED') || msg.includes('取得に失敗') || msg.includes('503') || msg.includes('Failed to fetch')) {
      return { name: 'LibreChat Agent', state: 'error', message: 'Agent取得に失敗 — LibreChat接続を確認してください', ownership: null, attempt_id: 0 };
    }
    return { name: 'LibreChat Agent', state: 'checking', message: '確認中...', ownership: null, attempt_id: 0 };
  }
}
async function fetchMcpRuntimeEntry(signal) {
  try {
    const data = await request('/api/mcp/status', { signal });
    if (!data.enabled) return { name: 'MCP', state: 'needs_setup', message: '無効', ownership: null, attempt_id: 0 };
    if (data.tokenConfigured) return { name: 'MCP', state: 'ready', message: '有効', ownership: null, attempt_id: 0 };
    return { name: 'MCP', state: 'needs_setup', message: '要設定', ownership: null, attempt_id: 0 };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { name: 'MCP', state: 'checking', message: '確認中...', ownership: null, attempt_id: 0 };
  }
}

async function pollRuntime() {
  if (runtimePolling) return;
  runtimePolling = true;
  if (runtimeAbort) runtimeAbort.abort();
  const controller = new AbortController();
  runtimeAbort = controller;
  let pollSucceeded = false;
  try {
    const invoke = getTauriInvoke();
    let base = null;
    if (invoke) {
      try {
        base = await invoke('runtime_status');
        if (Array.isArray(base)) {
          const hasSecret = JSON.stringify(base).toLowerCase().includes('sk-') || JSON.stringify(base).toLowerCase().includes('bearer');
          if (hasSecret) throw new Error('secret leaked');
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        // Tauri failure: fallback to HTTP below
        base = null;
      }
    }
    if (!base) {
      // Browser / fallback path: derive from /api/health. GPT-OSS health cannot be verified from browser layer.
      const health = await request('/api/health', { signal: controller.signal });
      runtimeVersion = health.version || null;
      const mcState = health.ok ? 'ready' : 'error';
      const mcMsg = health.ok ? '準備完了' : (health.librechat && !health.librechat.ok ? 'LibreChat 接続を確認してください' : 'MultiContext が利用できません');
      const lcState = health.librechat && health.librechat.ok ? 'ready' : 'error';
      const lcMsg = health.librechat && health.librechat.ok ? '接続済み' : 'LibreChat 接続を確認';
      // GPT-OSS cannot be probed from the browser layer. Preserve a trusted
      // READY result handed off by the startup screen instead of replacing it
      // with an endless CHECKING state after navigation.
      const cachedModel = runtimeStatuses.find((status) => status.name === 'モデル');
      const desktopPage = window.location.hostname === '127.0.0.1' && Boolean(localStorage.getItem('mcc_api_base'));
      const modelState = cachedModel?.state === 'ready' || desktopPage ? 'ready' : 'checking';
      const modelMsg = modelState === 'ready' ? (cachedModel.message || '準備完了') : 'デスクトップランタイムで確認中';
      base = [
        { name: 'モデル', state: modelState, message: modelMsg, ownership: null, attempt_id: 0 },
        { name: 'LibreChat', state: lcState, message: lcMsg, ownership: null, attempt_id: 0 },
        { name: 'MultiContext', state: mcState, message: mcMsg, ownership: null, attempt_id: 0 },
      ];
    }
    // A successful desktop startup probe is authoritative for the model.
    // Do not downgrade it to CHECKING when the browser fallback cannot probe
    // the local model endpoint directly after navigation.
    if (Array.isArray(base)) {
      const cachedModel = runtimeStatuses.find((status) => status.name === 'モデル');
      const baseModel = base.find((status) => status.name === 'モデル');
      if (cachedModel?.state === 'ready' && baseModel && baseModel.state !== 'ready') {
        Object.assign(baseModel, cachedModel);
      }
      // In the desktop flow, this page is reachable only after the startup
      // gate accepted the model. A later browser-side re-probe cannot inspect
      // the managed/external model reliably, so it must not downgrade that
      // already-approved state to CHECKING.
      const desktopStartupApproved = window.location.hostname === '127.0.0.1' && Boolean(localStorage.getItem('mcc_api_base'));
      const desktopFallbackModel = baseModel?.message === 'デスクトップランタイムで確認中';
      if ((desktopStartupApproved || desktopFallbackModel) && baseModel && baseModel.state !== 'error') {
        baseModel.state = 'ready';
        baseModel.message = '準備完了';
      }
    }
    if (controller.signal.aborted) return;
    // Always attempt to resolve agent availability as 4th row — never conflated with service health
    const agentEntry = await fetchAgentRuntimeEntry(controller.signal);
    if (controller.signal.aborted) return;
    const mcpEntry = await fetchMcpRuntimeEntry(controller.signal);
    if (controller.signal.aborted) return;
    const statuses = [...base, agentEntry, mcpEntry];
    runtimeStatuses = statuses;
    try { sessionStorage.setItem('multicontext_runtime', JSON.stringify(statuses)); } catch {}
    renderRuntime(statuses);
    pollSucceeded = true;
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('runtime poll failed', e);
    // If we have never succeeded, synthesize a converging failure state so UI does not stay forever "確認中"
    if (!runtimeStatuses || !runtimeStatuses.length) {
      const fallback = [
        { name: 'モデル', state: 'checking', message: '確認中...', ownership: null, attempt_id: 0 },
        { name: 'LibreChat', state: 'error', message: 'LibreChat に接続できません', ownership: null, attempt_id: 0 },
        { name: 'MultiContext', state: 'error', message: '確認できません', ownership: null, attempt_id: 0 },
        { name: 'LibreChat Agent', state: 'checking', message: '確認中...', ownership: null, attempt_id: 0 },
        { name: 'MCP', state: 'checking', message: '確認中...', ownership: null, attempt_id: 0 },
      ];
      runtimeStatuses = fallback;
      renderRuntime(fallback);
    }
    // pollSucceeded stays false → faster retry
  } finally {
    runtimePolling = false;
    if (runtimeAbort === controller) runtimeAbort = null;
    scheduleRuntimePoll(pollSucceeded ? 10000 : 3000);
  }
}

function scheduleRuntimePoll(delay = 10000) {
  clearTimeout(runtimePollTimer);
  runtimePollTimer = setTimeout(pollRuntime, delay);
}

function initRuntimeStatus() {
  // Try to restore transferred startup state for immediate READY display
  try {
    const raw = sessionStorage.getItem('multicontext_runtime') || localStorage.getItem('multicontext_runtime');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length >= 3) {
        // Startup has already performed the authoritative desktop probe. Some
        // Tauri versions serialize the external model status as `checking`
        // when the next page is loaded; retain the confirmed hand-off.
        const transferredModel = parsed.find((status) => status.name === 'モデル');
        if (transferredModel && /接続済み|準備完了/.test(String(transferredModel.message || '')) && transferredModel.state !== 'error') {
          transferredModel.state = 'ready';
        }
        runtimeStatuses = parsed;
        renderRuntime(parsed);
      }
    }
  } catch {}
  // Also try get_services cache from Tauri (if startup already did)
  const invoke = getTauriInvoke();
  if (invoke) {
    invoke('get_services').then((cached) => {
      if (Array.isArray(cached) && cached.length >= 3) {
        // Only use if we have no runtime yet or cached is more recent (has attempt_id)
        const hasRecent = cached.some(s => s.state === 'ready');
        if (hasRecent && !runtimeStatuses.length) {
          runtimeStatuses = cached;
          renderRuntime(cached);
          try { sessionStorage.setItem('multicontext_runtime', JSON.stringify(cached)); } catch {}
        }
      }
    }).catch(() => {});
  }
  // Wire dialog
  const btn = $('#runtimeStatus');
  const dialog = $('#runtimeDialog');
  const closeBtn = $('#runtimeClose');
  const refreshBtn = $('#runtimeRefresh');
  const logsBtn = $('#runtimeLogs');
  if (btn && dialog) {
    btn.addEventListener('click', () => {
      renderRuntime(runtimeStatuses);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open','');
      btn.setAttribute('aria-expanded','true');
    });
    closeBtn?.addEventListener('click', () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      btn.setAttribute('aria-expanded','false');
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        if (typeof dialog.close === 'function') dialog.close();
        btn.setAttribute('aria-expanded','false');
      }
    });
    refreshBtn?.addEventListener('click', () => {
      refreshBtn.disabled = true;
      pollRuntime().finally(() => { refreshBtn.disabled = false; });
    });
    logsBtn?.addEventListener('click', async () => {
      const inv = getTauriInvoke();
      if (inv) {
        try { await inv('open_logs_dir'); toast('ログフォルダを開きました','success'); } catch (e) { toast(String(e),'error'); }
      } else {
        toast('ログはデスクトップアプリで確認できます','');
      }
    });
  }
  // Start polling after a short delay, don't overlap with initial load
  setTimeout(pollRuntime, 2000);
  scheduleFocusPoll(2500);
}

// ── Desktop focus attach ────────────────────────────────────────────
// An external agent (MCP bootstrap launcher) records experiment starts via
// POST /api/workspaces/:id/focus. Consume the pending hint here: navigate to
// the workspace and bring the window forward — only on experiment start,
// never on routine traffic (the server only sets the hint for those).
let focusPollTimer = null;
let focusPolling = false;

function frontWindow() {
  try {
    const t = window.__TAURI__;
    const w = t && t.window && (typeof t.window.getCurrentWindow === 'function' ? t.window.getCurrentWindow() : null);
    if (w && typeof w.setFocus === 'function') { void w.setFocus().catch(() => {}); return; }
  } catch {}
  try { window.focus(); } catch {}
}

async function pollPendingFocus() {
  if (focusPolling) return;
  focusPolling = true;
  try {
    const data = await request('/api/focus/pending');
    const focus = data && data.focus;
    if (focus && focus.workspace_id) {
      await handleWorkspaceSelect(focus.workspace_id);
      // Attach run-level follow: the bar tracks this run until terminal.
      focusedRunId = focus.run_id || null;
      if (focus.run_id) openOrchestratorDrawer();
      frontWindow();
    }
  } catch {
    // Transient failure: keep polling; never break the runtime loop.
  } finally {
    focusPolling = false;
    scheduleFocusPoll(2500);
  }
}

function openOrchestratorDrawer() {
  const dlg = document.getElementById('orchestratorDrawer');
  if (!dlg) return;
  if (typeof dlg.showModal === 'function' && !dlg.open) {
    try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
  } else {
    dlg.setAttribute('open', '');
  }
}

function scheduleFocusPoll(delay = 2500) {
  clearTimeout(focusPollTimer);
  focusPollTimer = setTimeout(pollPendingFocus, delay);
}

function workspaceDot(members) {
  const arr = Object.values(members);
  if (!arr.length) return 'idle';
  if (arr.some((m) => m.status === 'error')) return 'blocked';
  if (arr.some((m) => m.status === 'running' || m.inFlight)) return 'running';
  if (arr.some((m) => m.queue && m.queue.length)) return 'pending';
  return arr.some((m) => m.messages && m.messages.length) ? 'settled' : 'idle';
}

function memberHasResolvedAgent(workspace, member) {
  const memberAgent = String(member.agentId || '').trim();
  const defaultAgent = String(workspace.defaultAgentId || '').trim();
  if (memberAgent) return agents.some((agent) => String(agent.id) === memberAgent);
  if (defaultAgent) return agents.some((agent) => String(agent.id) === defaultAgent);
  if (agents.length === 1) return true;
  return workspace.settings?.agentSelectionMode === 'auto_first' && agents.length > 0;
}

async function refreshAgents(expectedId = currentId) {
  try {
    const data = await request('/api/agents');
    if (expectedId !== currentId) return;
    agents = data.agents || [];
  } catch {
    if (expectedId !== currentId) return;
    agents = [];
  }
}

async function refreshList(expectedId = currentId) {
  const data = await request('/api/workspaces?include_archived=true');
  if (expectedId !== currentId) return;
  const workspaces = data.workspaces || [];
  if (!currentId) $('#app')?.setAttribute('aria-busy', 'false');
  const workspaceIds = new Set(workspaces.map((workspace) => String(workspace.id)));
  const validPinnedIds = [...pinnedWorkspaceIds].filter((id) => workspaceIds.has(String(id)));
  if (validPinnedIds.length !== pinnedWorkspaceIds.size) {
    pinnedWorkspaceIds = new Set(validPinnedIds);
    localStorage.setItem('mcc_pinned_workspaces', JSON.stringify(validPinnedIds));
  }
  const stateCounts = workspaces.reduce((counts, workspace) => {
    if (workspace.archived) { counts.ARCHIVED += 1; return counts; }
    const state = String(workspace.runtimeState || '').toUpperCase();
    if (state in counts) counts[state] += 1;
    return counts;
  }, { RUNNING: 0, PENDING: 0, BLOCKED: 0, SETTLED: 0, ARCHIVED: 0 });
  const attention = document.getElementById('attentionWorkspaces');
  if (attention) {
    const blockedCount = stateCounts.BLOCKED;
    attention.hidden = blockedCount === 0 || workspaceStatusFilter === 'BLOCKED';
    attention.textContent = `要対応 ${blockedCount}件`;
    attention.setAttribute('aria-label', `要対応のワークスペース ${blockedCount}件を見る`);
  }
  const archived = document.getElementById('archivedWorkspaces');
  if (archived) {
    const archivedCount = stateCounts.ARCHIVED;
    archived.hidden = archivedCount === 0 || workspaceStatusFilter === 'ARCHIVED';
    archived.textContent = `アーカイブ ${archivedCount}件`;
    archived.setAttribute('aria-label', `アーカイブ済みのワークスペース ${archivedCount}件を見る`);
  }
  const filterLabels = { all: 'すべての状態', RUNNING: '実行中', PENDING: 'キューあり', BLOCKED: '要対応', SETTLED: '完了', ARCHIVED: 'アーカイブ済み' };
  const activeWorkspaceCount = workspaces.filter((workspace) => !workspace.archived).length;
  $$('#workspaceFilter option').forEach((option) => {
    const value = option.value;
    option.textContent = `${filterLabels[value] || value} (${value === 'all' ? activeWorkspaceCount : (stateCounts[value] || 0)})`;
  });
  const scopedWorkspaces = workspaceStatusFilter === 'ARCHIVED' ? workspaces.filter((workspace) => workspace.archived) : workspaces.filter((workspace) => !workspace.archived);
  const query = workspaceSearchQuery.trim().toLowerCase();
  const visibleWorkspaces = scopedWorkspaces.filter((workspace) => {
    const matchesQuery = !query || String(workspace.name || '').toLowerCase().includes(query);
    const matchesStatus = workspaceStatusFilter === 'ARCHIVED' ? Boolean(workspace.archived) : !workspace.archived && (workspaceStatusFilter === 'all' || String(workspace.runtimeState || '').toUpperCase() === workspaceStatusFilter);
    return matchesQuery && matchesStatus;
  }).sort((a, b) => {
    const pinOrder = Number(pinnedWorkspaceIds.has(b.id)) - Number(pinnedWorkspaceIds.has(a.id));
    if (pinOrder) return pinOrder;
    return workspaceSort === 'name'
      ? String(a.name || '').localeCompare(String(b.name || ''), 'ja')
      : String(workspaceActivityTimestamp(b)).localeCompare(String(workspaceActivityTimestamp(a)));
  });
  const count = document.getElementById('workspaceCount');
  if (count) {
    count.textContent = (query || workspaceStatusFilter !== 'all')
      ? `${visibleWorkspaces.length}件 / ${scopedWorkspaces.length}件`
      : `${scopedWorkspaces.length}件`;
    count.setAttribute('aria-label', `ワークスペース ${count.textContent}`);
  }
  const resetView = document.getElementById('resetWorkspaceView');
  if (resetView) {
    const hasViewOverrides = Boolean(query) || workspaceStatusFilter !== 'all' || workspaceSort !== 'recent';
    resetView.classList.toggle('is-visible', hasViewOverrides);
    resetView.hidden = !hasViewOverrides;
    resetView.setAttribute('aria-hidden', String(!hasViewOverrides));
  }
  if (!scopedWorkspaces.length) {
    $('#workspaces').innerHTML = workspaceStatusFilter === 'ARCHIVED'
      ? '<div class="workspace-empty"><strong>アーカイブ済みのワークスペースはありません</strong><span class="small">アーカイブしたワークスペースはここに表示されます。</span></div>'
      : `<div class="workspace-empty"><strong>まだワークスペースがありません</strong><span class="small">チャットとAgentをまとめる場所を作成しましょう。</span><button class="sm" type="button" data-action="new-workspace-from-empty">新しいワークスペースを作成</button></div>`;
    $('#workspaces [data-action="new-workspace-from-empty"]')?.addEventListener('click', () => {
      document.getElementById('newWorkspace')?.click();
    });
    return;
  }
  if (!visibleWorkspaces.length) {
    $('#workspaces').innerHTML = `<div class="workspace-no-results">
      <span class="small">一致するワークスペースがありません</span>
      <button class="sm" type="button" data-action="clear-workspace-filters">条件をクリア</button>
    </div>`;
    $('#workspaces [data-action="clear-workspace-filters"]').onclick = () => {
      resetWorkspaceViewState();
      refreshList().catch((err) => toast(err.message, 'error'));
    };
    return;
  }
  const renderWorkspace = (workspace) => {
    const members = workspace.members || {};
    const count = Object.keys(members).length;
    const active = Object.values(members).filter((m) => m.active !== false).length;
    const rawState = workspace.runtimeState || null;
    const dot = rawState ? String(rawState).toLowerCase() : workspaceDot(members);
    const dotClass = dot === 'error' ? 'blocked' : dot;
    const isActive = workspace.id === currentId;
    const pinned = pinnedWorkspaceIds.has(workspace.id);
    const stateLabel = workspace.archived ? 'アーカイブ済み' : sharedWorkspaceLabel(rawState || dot.toUpperCase()).label;
    const workspaceLabel = `${workspace.name}、${stateLabel}、${active}件中${count}件のチャット`;
    const updatedLabel = workspaceUpdatedLabel(workspace);
    return `<div class="workspace-item" role="listitem"><button class="workspace-link ${isActive ? 'active' : ''}" data-id="${workspace.id}" title="${esc(workspace.name)} — ${esc(stateLabel)}" aria-current="${isActive ? 'page' : 'false'}" aria-label="${esc(workspaceLabel)}">
      <span class="ws-dot ${esc(dotClass)}" aria-hidden="true"></span>
      <span class="ws-name">${esc(workspace.name)}</span>
      ${updatedLabel ? `<span class="ws-updated" title="最終更新: ${esc(updatedLabel)}">${esc(updatedLabel)}</span>` : ''}
      <span class="ws-count">${active}/${count}</span>
    </button><button class="workspace-pin ${pinned ? 'pinned' : ''}" data-action="toggle-pin" data-id="${workspace.id}" type="button" aria-pressed="${pinned}" aria-label="${pinned ? 'ピン留めを解除' : 'ワークスペースをピン留め'}" title="${pinned ? 'ピン留めを解除' : 'ピン留め'}">★</button></div>`;
  };
  const pinnedWorkspaces = visibleWorkspaces.filter((workspace) => pinnedWorkspaceIds.has(workspace.id));
  const otherWorkspaces = visibleWorkspaces.filter((workspace) => !pinnedWorkspaceIds.has(workspace.id));
  const isDefaultWorkspaceView = !query && workspaceStatusFilter === 'all' && workspaceSort === 'recent';
  const workspacePageSize = 12;
  const shouldCollapseOthers = isDefaultWorkspaceView && !workspaceListExpanded && otherWorkspaces.length > workspacePageSize;
  let displayedOtherWorkspaces = shouldCollapseOthers
    ? otherWorkspaces.slice(0, workspacePageSize)
    : otherWorkspaces;
  if (shouldCollapseOthers && currentId && otherWorkspaces.some((workspace) => String(workspace.id) === String(currentId)) && !displayedOtherWorkspaces.some((workspace) => String(workspace.id) === String(currentId))) {
    displayedOtherWorkspaces = [...displayedOtherWorkspaces.slice(0, -1), otherWorkspaces.find((workspace) => String(workspace.id) === String(currentId))];
  }
  const renderGroup = (label, items) => items.length
    ? `<div class="workspace-group" role="presentation"><div class="workspace-group-label">${esc(label)} <span>${items.length}件</span></div>${items.map(renderWorkspace).join('')}</div>`
    : '';
  const remainingCount = otherWorkspaces.length - displayedOtherWorkspaces.length;
  const showMore = shouldCollapseOthers
    ? `<button class="workspace-more" type="button" data-action="expand-workspaces">さらに表示（あと${remainingCount}件）</button>`
    : '';
  $('#workspaces').innerHTML = renderGroup('ピン留め', pinnedWorkspaces) + renderGroup('その他', displayedOtherWorkspaces) + showMore;
  $$('[data-action="toggle-pin"]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const id = button.dataset.id;
      const willPin = !pinnedWorkspaceIds.has(id);
      if (willPin) pinnedWorkspaceIds.add(id); else pinnedWorkspaceIds.delete(id);
      localStorage.setItem('mcc_pinned_workspaces', JSON.stringify([...pinnedWorkspaceIds]));
      toast(willPin ? 'ワークスペースをピン留めしました' : 'ピン留めを解除しました', 'success');
      refreshList().catch((err) => toast(err.message, 'error'));
    };
  });
  $('[data-action="expand-workspaces"]')?.addEventListener('click', () => {
    workspaceListExpanded = true;
    refreshList().catch((err) => toast(err.message, 'error'));
  });
  $$('.workspace-link').forEach((button) => {
    button.onclick = () => { closeSidebar(); handleWorkspaceSelect(button.dataset.id); };
    button.onkeydown = (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = $$('.workspace-link');
      const index = buttons.indexOf(button);
      if (index < 0) return;
      event.preventDefault();
      const nextIndex = event.key === 'ArrowDown' ? (index + 1) % buttons.length
        : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : buttons.length - 1;
      buttons[nextIndex]?.focus();
    };
  });
}

function handleWorkspaceSelect(id) {
  // Clicking the already-open workspace must never refresh away unsaved edits.
  if (id === currentId) return;
  if (isWorkspaceDirty() && currentId) {
    const ok = confirm('未保存の変更があります。破棄して別のワークスペースに移動しますか？');
    if (!ok) return;
  }
  return select(id);
}

async function select(id) {
  if (refreshController) refreshController.abort();
  currentId = id;
  localStorage.setItem('mcc_last_workspace', String(id));
  openEditors.clear();
  await Promise.all([refreshList(id), refreshAgents(id)]);
  if (currentId !== id) return;
  await refresh(id);
  if (currentId !== id) return;
  scheduleNext();
}

function workspaceStatusHtml(state) {
  const { label, cls } = sharedWorkspaceLabel(state);
  return `<span class="status ${esc(cls)}" title="ランタイム状態: ${esc(label)} — 生成中/キュー/ブロックの有無のみを示し、合意や完了を意味しません">${esc(label)}</span>`;
}
function memberStatusHtml(state) {
  const { label, cls } = sharedMemberLabel(state);
  return `<span class="status ${esc(cls)}">${esc(label)}</span>`;
}
// legacy alias
function workspaceStatusLabel(state) { return workspaceStatusHtml(state); }
function memberStatusLabel(state) { return memberStatusHtml(state); }
function statusLabel(state) { return memberStatusHtml(state); }

function queueInfo(member) {
  const count = member.queue.length;
  const inFlight = member.inFlight ? 1 : 0;
  const cls = count > 0 || inFlight ? 'queue-badge has-items' : 'queue-badge';
  const parts = [];
  if (inFlight) parts.push('処理中');
  if (count > 0) parts.push(`${count}件キュー`);
  if (!parts.length) parts.push('待機中');
  return `<span class="${cls}">${parts.join(' · ')}</span>`;
}

// ── Snapshot / restore form state across refresh ────────────────
function snapshotFormState() {
  const snap = {};
  for (const id of ['wname', 'globalPrompt', 'broadcastPrompt', 'compileAgentId', 'compilePrompt']) {
    const el = document.getElementById(id);
    if (el) snap[id] = el.value;
  }
  $$('.member').forEach((card) => {
    const mid = card.dataset.mid;
    for (const name of ['name', 'agentId', 'developerPrompt']) {
      const el = $(`[name="${name}"]`, card);
      if (el) snap[`member:${mid}:${name}`] = el.value;
    }
    for (const name of ['active', 'canInspectOthers', 'canSendOthers']) {
      const el = $(`[name="${name}"]`, card);
      if (el) snap[`member:${mid}:${name}`] = el.checked;
    }
    // direct send drafts
    const direct = card.querySelector('[data-action=direct] input');
    if (direct) snap[`direct:${mid}`] = direct.value;
  });
  return snap;
}

function restoreFormState(snap) {
  if (!snap) return;
  for (const id of ['wname', 'globalPrompt', 'broadcastPrompt', 'compileAgentId', 'compilePrompt']) {
    const el = document.getElementById(id);
    if (el && snap[id] !== undefined) el.value = snap[id];
  }
  $$('.member').forEach((card) => {
    const mid = card.dataset.mid;
    for (const name of ['name', 'agentId', 'developerPrompt']) {
      const el = $(`[name="${name}"]`, card);
      if (el && snap[`member:${mid}:${name}`] !== undefined) el.value = snap[`member:${mid}:${name}`];
    }
    for (const name of ['active', 'canInspectOthers', 'canSendOthers']) {
      const el = $(`[name="${name}"]`, card);
      if (el && snap[`member:${mid}:${name}`] !== undefined) el.checked = snap[`member:${mid}:${name}`];
    }
    const direct = card.querySelector('[data-action=direct] input');
    if (direct && snap[`direct:${mid}`] !== undefined) direct.value = snap[`direct:${mid}`];
  });
}

// ── Snapshot / restore scroll positions across refresh ───────────
function snapshotScrollPositions() {
  const snaps = { _app: null };
  const appEl = document.getElementById('app');
  if (appEl) snaps._app = appEl.scrollTop;
  document.querySelectorAll('[data-mid]').forEach((article) => {
    const msg = article.querySelector('.messages');
    if (msg) snaps[article.dataset.mid] = {
      top: msg.scrollTop,
      stickToBottom: msg.scrollHeight - msg.scrollTop - msg.clientHeight < 24,
    };
  });
  return snaps;
}

function restoreScrollPositions(snaps) {
  if (snaps._app != null) {
    const appEl = document.getElementById('app');
    if (appEl) appEl.scrollTop = snaps._app;
  }
  for (const [mid, snapshot] of Object.entries(snaps)) {
    if (mid === '_app' || snapshot == null) continue;
    const msg = document.querySelector(`[data-mid="${mid}"] .messages`);
    if (!msg) continue;
    const top = typeof snapshot === 'number' ? snapshot : snapshot.top;
    msg.scrollTop = snapshot.stickToBottom ? msg.scrollHeight : top;
  }
}

function isWorkspaceDirty() {
  if (!lastWorkspace || !currentId || lastWorkspace.id !== currentId) return false;
  const cur = {
    wname: $('#wname')?.value ?? '',
    globalPrompt: $('#globalPrompt')?.value ?? '',
    compileAgentId: $('#compileAgentId')?.value ?? '',
    compilePrompt: $('#compilePrompt')?.value ?? '',
  };
  const srv = {
    wname: String(lastWorkspace.name || ''),
    globalPrompt: String(lastWorkspace.globalPrompt || ''),
    compileAgentId: String(lastWorkspace.compileAgentId || ''),
    compilePrompt: String(lastWorkspace.compilePrompt || ''),
  };
  if (cur.wname !== srv.wname || cur.globalPrompt !== srv.globalPrompt || cur.compileAgentId !== srv.compileAgentId || cur.compilePrompt !== srv.compilePrompt) return true;
  // check member drafts
  for (const [mid, member] of Object.entries(lastWorkspace.members || {})) {
    const card = document.querySelector(`[data-mid="${mid}"]`);
    if (!card) continue;
    for (const name of ['name', 'agentId', 'developerPrompt']) {
      const el = card.querySelector(`[name="${name}"]`);
      if (el && el.value !== String(member[name] ?? '')) return true;
    }
    for (const name of ['active', 'canInspectOthers', 'canSendOthers']) {
      const el = card.querySelector(`[name="${name}"]`);
      if (el && el.checked !== Boolean(member[name])) return true;
    }
  }
  return false;
}

window.addEventListener('beforeunload', (event) => {
  if (!isWorkspaceDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

async function refreshPreservingDrafts(expectedId = currentId) {
  const snap = snapshotFormState();
  const scrolls = snapshotScrollPositions();
  // snapshot openEditors handled via Set persistence
  const sameWorkspace = expectedId === currentId && lastWorkspace && expectedId === lastWorkspace.id;
  await refresh(expectedId);
  if (!sameWorkspace && expectedId !== currentId) return;
  // only restore if still on same workspace and member still exists
  if (expectedId === currentId) {
    restoreFormState(snap);
    restoreScrollPositions(scrolls);
    for (const id of ['wname','globalPrompt','compileAgentId','compilePrompt']) {
      const el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

// ── Periodic tick ────────────────────────────────────────────────
let ticking = false;
function tick() {
  if (ticking) return;
  const active = document.activeElement;
  if (active && active.closest && active.closest('#app')) { scheduleNext(); return; }
  ticking = true;
  const snap = snapshotFormState();
  const scrolls = snapshotScrollPositions();
  refresh().then(() => {
    restoreFormState(snap);
    restoreScrollPositions(scrolls);
    for (const id of ['wname','globalPrompt','compileAgentId','compilePrompt']) {
      const el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }).finally(() => { ticking = false; scheduleNext(); });
}

// Observer cadence: fast (1.2s) while attached to a live run or while the
// workspace has active work; relaxed (5s) when idle so the observer loop
// stops churning after a followed run reaches terminal state.
function observerDelay() {
  try {
    if (focusedRunId && orchestratorState && followedRunState(orchestratorState.runs, focusedRunId) !== 'terminal') return 1200;
  } catch {}
  try {
    const rs = lastWorkspace && lastWorkspace.runtimeState;
    if (rs === 'RUNNING' || rs === 'PENDING' || rs === 'BLOCKED') return 1200;
  } catch {}
  return 5000;
}
function scheduleNext() { clearTimeout(timer); timer = setTimeout(tick, observerDelay()); }

// ── Orchestrator Bar ──────────────────────────────────────────
let orchestratorTimer = null;
let orchestratorState = null;
// Run id attached via experiment-start focus hint; followed until terminal.
let focusedRunId = null;
async function refreshOrchestrator() {
  if (!currentId) return;
  const expectedId = currentId;
  try {
    const data = await request(`/api/workspaces/${expectedId}/orchestrator`);
    if (expectedId !== currentId) return;
    orchestratorState = data;
    renderOrchestratorBar(data);
    // Keep an open drawer live: re-render its body on every orchestrator
    // poll so the observer sees queue/member/tool activity move without
    // clicking anything. Closed drawers cost nothing.
    const dlg = document.getElementById('orchestratorDrawer');
    if (dlg && (dlg.open || dlg.hasAttribute('open'))) renderOrchestratorDrawer(data);
  } catch {}
}
// Renders the drawer body from fresh orchestrator state. Pure DOM write of
// already-escaped content; safe to call on every poll while open.
function renderOrchestratorDrawer(data) {
  const body = document.getElementById('orchestratorDrawerBody');
  if (!body || !data) return;
  const queueStateLabels = { pending: '待機中', queued: '待機中', running: '実行中', done: '完了', failed: '失敗', cancelled: 'キャンセル' };
  const qPending = data.queue || [];
  const qHistory = data.queueHistory || [];
  const memberNames = {};
  try {
    for (const [id, m] of Object.entries((lastWorkspace && lastWorkspace.members) || {})) {
      if (m && m.name) memberNames[id] = m.name;
    }
  } catch {}
  const activity = selectActivityEvents(data.events, { limit: 30, memberNames });
  const activityHtml = activity.map((row) => {
    const who = row.actor ? `<strong>${esc(row.actor)}</strong> ` : '';
    const tgt = row.target ? ` → <strong>${esc(row.target)}</strong>` : '';
    const det = row.detail ? ` <span style="color:var(--text-muted)">${esc(row.detail)}</span>` : '';
    const run = row.runId ? ` <span style="color:var(--text-muted)">[${esc(row.runId)}]</span>` : '';
    return `<div class="orchestrator-event ${esc(row.origin || '')}">${esc(row.time)} ${who}${esc(row.action)}${tgt}${det}${run}</div>`;
  }).join('') || '<div class="small">活動はまだありません</div>';
  const pendingHtml = [0,1,2].map(p=>{
    const items=qPending.filter(x=>x.priority===p);
    const title = `Q${p} 待機中 (${items.length})`;
    const rows = items.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(queueStateLabels[it.state] || it.state)} ${esc(it.prompt.slice(0,80))} <span style="color:var(--text-muted)">${esc(it.origin)}/${esc(it.runId||'')}</span></div>`).join('') || '<div class="small">空です</div>';
    return `<div class="orchestrator-q-group"><div class="orchestrator-q-title">${esc(title)}</div>${rows}</div>`;
  }).join('');
  const historyItems = qHistory.slice(-10);
  const histHtml = `<div class="orchestrator-q-group"><div class="orchestrator-q-title">履歴 (${qHistory.length})</div>${historyItems.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(queueStateLabels[it.state] || it.state)} ${esc(it.prompt.slice(0,60))}</div>`).join('') || '<div class="small">空です</div>'}</div>`;
  const eventLabels = {
    'compile.started': 'Compileを開始', 'compile.completed': 'Compileが完了', 'compile.failed': 'Compileに失敗',
    'member.started': 'メンバーの実行を開始', 'member.completed': 'メンバーの実行が完了',
    'member.failed': 'メンバーの実行に失敗', 'member.cancelled': 'メンバーをキャンセル',
    'human.retry': '再試行を開始', 'human.stop': '停止', 'human.send': '直接送信',
    'human.broadcast': 'ブロードキャスト送信', 'q.enqueued': 'キューへ追加', 'q.dispatched': 'キューを配信',
    'tool.list_chats': 'チャット一覧を取得', 'tool.inspect_chat': 'チャットを確認',
    'tool.send_to_chat': 'チャットへ送信', 'tool.replayed': 'ツールを再生',
    'mcp.run.started': '実行を開始', 'run.settled': '実行が完了', 'run.blocked': '実行がブロック',
    'run.failed': '実行に失敗', 'run.cancelled': '実行をキャンセル',
  };
  const evHtml = (data.events||[]).slice(-20).reverse().map(e=>`<div class="orchestrator-event ${esc(e.origin)}">${esc(e.ts.slice(11,19))} ${esc(eventLabels[e.type] || e.type)} <span style="color:var(--text-muted)">${esc(e.origin)}${e.actor?'/'+esc(e.actor):''}</span></div>`).join('');
  body.innerHTML = `<div class="orchestrator-q-group"><div class="orchestrator-q-title">ライブ活動</div>${activityHtml}</div>` + pendingHtml + histHtml + `<div class="orchestrator-q-group"><div class="orchestrator-q-title">イベント</div>${evHtml || '<div class="small">イベントはまだありません</div>'}</div>`;
}
function renderOrchestratorBar(data) {
  const bar = document.getElementById('orchestratorBar');
  if (!bar || !data) return;
  bar.style.display = 'flex';
  // P1 fix: use pending/history split from store (queue is pending only, queueHistory is terminal)
  const qPending = data.queue || [];
  const qHistory = data.queueHistory || [];
  const counts = data.counts || { q0: qPending.filter(x=>x.priority===0).length, q1: qPending.filter(x=>x.priority===1).length, q2: qPending.filter(x=>x.priority===2).length };
  const q0 = counts.q0, q1 = counts.q1, q2 = counts.q2;
  const runs = data.runs || [];
  const picked = pickDisplayedRun(runs, focusedRunId);
  // Drop the hint only once the followed run is observably terminal; an
  // unknown id means orchestrator state lags run creation, so keep waiting.
  if (followedRunState(runs, focusedRunId) === 'terminal') focusedRunId = null;
  const cur = picked.run;
  const following = picked.following;
  // P1 fix: derive bar state correctly (was always RUNNING)
  let barState = 'IDLE', dotCls = 'idle';
  if (data.paused) { barState = 'PAUSED'; dotCls = 'paused'; }
  else if (cur && cur.status==='running') { barState = 'RUNNING'; dotCls = 'running'; }
  else if (cur && cur.status==='queued') { barState = 'QUEUED'; dotCls = 'pending'; }
  else if (qPending.length>0) { barState = 'QUEUED'; dotCls = 'pending'; }
  else if (cur && ['blocked','failed'].includes(cur.status)) { barState = cur.status.toUpperCase(); dotCls = 'blocked'; }
  const runStateLabels = { running: '実行中', queued: '待機中', blocked: '要対応', failed: '失敗', settled: '完了', cancelled: 'キャンセル' };
  const curText = cur ? `${esc(cur.id.slice(0,4))}:${esc(runStateLabels[cur.status] || '状態確認中')}` : '—';
  const barStateLabels = { IDLE: '待機中', PAUSED: '一時停止', RUNNING: '実行中', QUEUED: 'キューあり', BLOCKED: '要対応', FAILED: '失敗' };
  const liveMembers = Object.values(lastWorkspace?.members || {}).filter(member => member.active !== false);
  const runningMembers = liveMembers.filter(member => member.status === 'running').length;
  const answeredMembers = liveMembers.filter(member => (member.messages || []).some(message => message.role === 'assistant')).length;
  const progress = liveMembers.length ? Math.round((answeredMembers / liveMembers.length) * 100) : 0;
  const followTag = following && cur ? ` <span class="ob-follow" title="Agent experiment under observation">◎追跡中 ${esc(cur.id.slice(0,8))}</span>` : '';
  bar.innerHTML = `
    <span class="ob-dot ${esc(dotCls)}"></span>
    <strong>実行管理</strong> <span class="ob-sep">·</span> ${esc(barStateLabels[barState] || '状態確認中')}${followTag}
    <span class="ob-sep">·</span> Q0 ${q0} <span class="ob-sep">|</span> Q1 ${q1} <span class="ob-sep">|</span> Q2 ${q2}
    <span class="ob-sep">·</span> ${curText}
    <span class="ob-progress" title="回答済み ${answeredMembers} / ${liveMembers.length} チャット"><span class="ob-progress-track"><span style="width:${progress}%"></span></span><span>${answeredMembers}/${liveMembers.length}${runningMembers ? ` 実行中${runningMembers}` : ''}</span></span>
    <span style="flex:1"></span>
    <button class="sm" id="orchPauseBtn">${data.paused?'再開':'一時停止'}</button>
    <button class="sm" id="orchQueueBtn">キューを見る</button>
  `;
  bar.querySelector('#orchPauseBtn')?.addEventListener('click', async () => {
    await request(`/api/workspaces/${currentId}/orchestrator/pause`, { method:'POST', body: JSON.stringify({ paused: !data.paused }) });
    refreshOrchestrator();
  });
  bar.querySelector('#orchQueueBtn')?.addEventListener('click', () => {
    const dlg=document.getElementById('orchestratorDrawer');
    renderOrchestratorDrawer(data);
    if (dlg && typeof dlg.showModal==='function') dlg.showModal(); else dlg?.setAttribute('open','');
  });
  document.getElementById('orchestratorClose')?.addEventListener('click', ()=>{ const d=document.getElementById('orchestratorDrawer'); if(d.close) d.close(); else d.removeAttribute('open'); });
}
function scheduleOrchestrator() { clearTimeout(orchestratorTimer); orchestratorTimer=setTimeout(()=>{ refreshOrchestrator().finally(scheduleOrchestrator); }, 3000); }

function memberCard(workspace, member) {
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
  const canSend = member.active !== false && memberHasResolvedAgent(workspace, member);
  const effectiveAgentId = String(member.agentId || workspace.defaultAgentId || '').trim();
  const isStaleMember = member.agentId && !agents.some(a => String(a.id) === String(member.agentId));
  const isStaleWorkspace = workspace.defaultAgentId && !agents.some(a => String(a.id) === String(workspace.defaultAgentId));
  const agentLabel = (() => {
    if (member.agentId) {
      if (isStaleMember) return `利用不可: ${esc(member.agentId)}`;
      return agentNameForId(member.agentId) || member.agentId;
    }
    if (workspace.defaultAgentId) {
      if (isStaleWorkspace) return `利用不可: ${esc(workspace.defaultAgentId)}（既定）`;
      return `${agentNameForId(workspace.defaultAgentId) || workspace.defaultAgentId}（既定）`;
    }
    if (agents.length === 1) return `${agentNameForId(agents[0].id) || agents[0].id}（自動）`;
    if (agents.length > 1) return '未設定 — 選択してください';
    return '未設定';
  })();
  const agentTitle = (() => {
    if (member.agentId) return isStaleMember ? `利用不可: ${member.agentId}` : `個別: ${member.agentId}`;
    if (workspace.defaultAgentId) return isStaleWorkspace ? `利用不可: ${workspace.defaultAgentId}` : `ワークスペース既定: ${workspace.defaultAgentId}`;
    if (agents.length === 1) return `自動: ${agents[0].id}`;
    if (agents.length > 1) return '未設定 — 選択してください';
    return '未設定';
  })();
  // Japanese error normalization for display
  const displayError = (() => {
    if (!member.lastError) return '';
    const m = String(member.lastError);
    if (m.includes('LibreChat agentId is required')) return '利用可能なLibreChat Agentが設定されていません。LibreChatでAgentを作成するか、設定からAgentを選択してください。';
    if (/context size|context length|too many tokens/i.test(m)) return '会話の履歴がAgentのコンテキスト上限を超えました。キューと履歴は保持されています。履歴を整理してから、もう一度再試行してください。';
    if (m.includes('peg-native format')) return 'Agentの応答形式を確認できませんでした。キューは保持されています。もう一度実行してください。';
    return m;
  })();
  const contextLimitError = /context size|context length|too many tokens/i.test(String(member.lastError || ''));
  return `
    <article class="member" data-mid="${member.id}">
      <div class="member-header">
        <div class="member-title">
          <span class="member-name">${esc(member.name)}</span>
          ${memberStatusHtml(member.status)}
        </div>
        <div class="member-actions">
          ${member.status === 'error' ? `${contextLimitError ? '<button class="sm" data-action="trim-history" title="直近12件だけを残して履歴を整理">履歴を整理</button>' : ''}<button class="sm primary" data-action="retry" title="${contextLimitError ? '履歴を整理してから、キューを保持したまま再試行' : 'キューを保持したまま再試行'}">${contextLimitError ? '整理後に再試行' : '再試行'}</button>` : ''}
          ${member.inFlight ? '<button class="sm danger" data-action="stop" title="実行中の生成を停止">停止</button>' : ''}
          <button class="sm" data-action="edit" aria-expanded="${openEditors.has(member.id) ? 'true' : 'false'}" title="設定">設定</button>
          <button class="sm" data-action="copytool" title="Action URLをコピー">URL</button>
        </div>
      </div>
      <div class="member-meta">
        <span title="${esc(agentTitle)}">エージェント: <strong>${esc(agentLabel)}</strong></span>
        <span class="sep">·</span>
        ${queueInfo(member)}
        ${member.active === false ? '<span class="sep">·</span><span style="color:var(--text-muted)">無効</span>' : ''}
      </div>
      ${displayError ? `<div class="member-error" role="alert"><strong>処理を続行できませんでした</strong><span>${esc(displayError)}</span><small>会話の履歴とキューは保持されています。</small></div>` : ''}
      <div class="member-body">
        <div class="dev-prompt">
          <div class="dev-prompt-label">Developer Prompt <span class="scope-note">— このチャットのみ</span></div>
          <div class="dev-prompt-text">${esc(member.developerPrompt) || ''}</div>
        </div>
        <div class="member-editor${editorOpen}">
          <div class="editor-row">
            <label>名前 <input name="name" value="${esc(member.name)}" autocomplete="off"></label>
            <label>エージェント <select name="agentId">${agentOptionsHtml(member.agentId, true)}</select></label>
          </div>
          <label>Developer Prompt<textarea name="developerPrompt" placeholder="このチャットのみに適用される developer role の指示">${esc(member.developerPrompt)}</textarea></label>
          <div class="editor-row">
            <div class="check-row">
              <label><input type="checkbox" name="active" ${member.active ? 'checked' : ''}> 有効</label>
              <label><input type="checkbox" name="canInspectOthers" ${member.canInspectOthers ? 'checked' : ''}> ピアを参照</label>
              <label><input type="checkbox" name="canSendOthers" ${member.canSendOthers ? 'checked' : ''}> ピアに送信</label>
            </div>
          </div>
          <div class="editor-actions">
            <button class="sm primary" data-action="save">保存</button>
            <button class="sm danger" data-action="delete">削除</button>
          </div>
          <div class="action-url" title="${esc(member.actionSpecUrl || '')}">${esc(member.actionSpecUrl || '')}</div>
        </div>
        <div class="messages" role="log" aria-live="polite">
          ${member.messages.length === 0 ? '<div class="small" style="padding:12px;text-align:center">まだメッセージがありません — ブロードキャストか直接送信で会話を始めましょう</div>' : ''}
          ${member.messages.map((message) => `
            <div class="msg ${esc(message.role)} ${message.pending ? 'pending-msg' : ''}">
              <div class="msg-head">${esc(message.role)}${message.at ? ` · ${esc(message.at)}` : ''}${message.pending ? ' · 処理中' : ''}</div>
              ${esc(message.content)}
            </div>
          `).join('')}
        </div>
        <div class="member-footer">
          <div class="small" style="font-size:10px; color:var(--text-muted); margin-bottom:4px; letter-spacing:0.02em">このチャットだけに送信</div>
          <form data-action="direct">
            <input placeholder="${canSend ? `プロンプトを入力 — ${shortcutModifier}↵` : 'Agentを選択してから送信できます'}" aria-label="このチャットだけに送信するプロンプト" ${canSend ? '' : 'disabled'}>
            <button class="sm primary" ${canSend ? '' : 'disabled'} title="${canSend ? 'このチャットだけに送信' : 'Agentを選択してから送信できます'}" aria-label="このチャットだけに送信">送信</button>
          </form>
        </div>
      </div>
    </article>
  `;
}

async function refresh(expectedId = currentId) {
  if (!expectedId) return;
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const app = $('#app');
  app?.setAttribute('aria-busy', 'true');
  try {
    const workspace = await request(`/api/workspaces/${expectedId}`, { signal: controller.signal });
    if (controller.signal.aborted || expectedId !== currentId) return;
    lastWorkspace = workspace;
    document.title = `${workspace.name || 'ワークスペース'} — MultiContext`;
    const members = Object.values(workspace.members);
    const activeMembers = members.filter((m) => m.active !== false);
    const queuedMessages = members.reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    const runningMembers = members.filter((member) => member.inFlight).length;
    const hasWorkToStop = runningMembers > 0 || queuedMessages > 0;
    const assistantMessages = members.reduce((sum, member) => sum + (member.messages || []).filter((message) => message.role === 'assistant').length, 0);
    const agentOptions = agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}${agent.provider ? ` · ${esc(agent.provider)}` : ''}</option>`).join('');
    const allAgentsReady = activeMembers.every((member) => memberHasResolvedAgent(workspace, member));
    const canBroadcast = activeMembers.length > 0 && allAgentsReady;
    const compileStateBlocked = workspace.runtimeState !== 'SETTLED';
    const compileAgentReady = Boolean(workspace.compileAgentId || workspace.defaultAgentId || agents.length === 1);
    const compileDisabled = compileStateBlocked || !compileAgentReady;
    const archiveDisabled = !workspace.archived && ['RUNNING', 'PENDING'].includes(String(workspace.runtimeState || '').toUpperCase());
    const compileHint = compileStateBlocked
      ? `コンパイルは ${workspace.runtimeState || '現在の状態'} の間は利用できません — SETTLED になるまで待ってください`
      : !compileAgentReady
        ? 'Compileに使用するAgentを選択するか、ワークスペース既定Agentを設定してください'
        : '全チャットの直近メッセージを要約';
    $('#app').innerHTML = `
      <datalist id="agentOptions">${agentOptions}</datalist>

      <div class="workspace-head">
        <div class="workspace-top">
          <div class="workspace-identity">
            <input id="wname" value="${esc(workspace.name)}" maxlength="120" aria-label="ワークスペース名" title="ワークスペース名は120文字以内です">
            ${workspaceStatusHtml(workspace.runtimeState)}${workspace.archived ? '<span class="status archived">アーカイブ済み</span>' : ''}
          </div>
          <div class="workspace-toolbar">
            <span id="workspaceSaveState" class="save-state" aria-live="polite">保存済み</span><button id="refreshWorkspace" class="sm" type="button" title="ワークスペースの状態を更新" aria-label="ワークスペースの状態を更新">↻ 更新</button><button id="saveWorkspace" class="sm primary" title="ワークスペース・System Prompt・Compile設定を保存">ワークスペース設定を保存</button>
            <button id="addMember" class="sm" title="新しいチャットを追加">+ チャット</button>
            <button id="stop" class="sm danger" ${hasWorkToStop ? '' : 'disabled'} title="${hasWorkToStop ? `実行中${runningMembers}件・キュー${queuedMessages}件を停止` : '停止する生成やキューはありません'}">全て停止</button>
            <button id="archiveWorkspace" class="sm" ${archiveDisabled ? 'disabled' : ''} title="${archiveDisabled ? '実行中またはキュー待ちのためアーカイブできません' : workspace.archived ? 'ワークスペースを通常一覧へ戻す' : 'ワークスペースをアーカイブ一覧へ移す'}">${workspace.archived ? '復元' : 'アーカイブ'}</button>
            <button id="deleteWorkspace" class="sm danger" title="このワークスペースを削除">削除</button>
          </div>
        </div>
        <div class="workspace-fields">
          <label for="globalPrompt" class="field-label">共有 System Prompt <span class="scope-note">— 全チャットに system role として適用</span></label>
          <textarea id="globalPrompt" placeholder="全チャット共通の system 指示を入力（例: あなたは簡潔に答えるアシスタントです）" aria-label="共有 System Prompt">${esc(workspace.globalPrompt)}</textarea>
          <div class="hint">指示階層: System Prompt（共有） → Developer Prompt（チャット固有） → user（Broadcast / Direct）。nativeはLibreChat会話を継続、compatはローカル履歴を再生。 · <span class="small">${activeMembers.length}件アクティブ / 全${members.length}件</span></div>
          <label for="defaultAgentId" class="field-label" style="margin-top:8px">既定エージェント <span class="scope-note">— 新しいチャットや「ワークスペース既定を使用」の解決先</span></label>
          <select id="defaultAgentId" aria-label="既定エージェント">${agentOptionsHtml(workspace.defaultAgentId, false)}</select>
          <label for="agentSelectionMode" class="field-label" style="margin-top:8px">Agent未指定時の動作</label>
          <select id="agentSelectionMode" aria-label="Agent未指定時の動作">
            <option value="require_selection" ${workspace.settings?.agentSelectionMode !== 'auto_first' ? 'selected' : ''}>明示選択を要求（安全）</option>
            <option value="auto_first" ${workspace.settings?.agentSelectionMode === 'auto_first' ? 'selected' : ''}>先頭Agentを自動選択（簡易）</option>
          </select>
          ${agents.length ? '' : '<div class="hint" style="color:var(--danger)">利用可能なAgentがありません。LibreChatでAgentを作成してください。</div>'}
        </div>
      </div>

      <section class="workspace-overview" aria-label="ワークスペース概要">
        <div class="overview-item"><span class="overview-label">アクティブチャット</span><strong>${activeMembers.length}<small> / ${members.length} チャット</small></strong></div>
        <div class="overview-item"><span class="overview-label">実行中</span><strong class="${runningMembers ? 'has-work' : ''}">${runningMembers}<small> 件</small></strong></div>
        <div class="overview-item"><span class="overview-label">待機キュー</span><strong class="${queuedMessages ? 'has-work' : ''}">${queuedMessages}<small> 件</small></strong></div>
        <div class="overview-item"><span class="overview-label">回答数</span><strong>${assistantMessages}<small> 件</small></strong></div>
        <div class="overview-item overview-action"><span class="overview-label">統合レポート</span><strong>${workspace.lastCompile ? '利用可能' : '未作成'}</strong></div>
      </section>

      <div id="orchestratorBar" class="orchestrator-bar" style="display:none"></div>
      <dialog id="orchestratorDrawer"><div class="orchestrator-drawer-head"><strong>Orchestrator</strong><button id="orchestratorClose" class="sm">閉じる</button></div><div id="orchestratorDrawerBody" class="orchestrator-drawer-body"><div class="small">読み込み中...</div></div></dialog>
      <div class="section-label">Broadcast <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${canBroadcast ? `全${activeMembers.length}件へ` : 'アクティブなチャットがありません'}</span></div>
      <div class="composer ${canBroadcast ? '' : 'disabled'}">
        <div style="flex:1; display:flex; flex-direction:column">
          <label for="broadcastPrompt" class="composer-label">全アクティブチャットへ <span class="scope-note">— 1つのプロンプトを全チャットへ複製</span></label>
          <textarea id="broadcastPrompt" placeholder="${canBroadcast ? '全アクティブチャットに同じプロンプトを送信' : activeMembers.length ? '全チャットのAgentを選択してから送信できます' : 'チャットを追加してからブロードキャストできます'}" aria-label="Broadcast プロンプト — 全アクティブチャットへ" ${canBroadcast ? '' : 'disabled'}></textarea>
        </div>
        <button class="primary" id="broadcast" ${canBroadcast ? '' : 'disabled'} title="${canBroadcast ? '全アクティブチャットに送信' : activeMembers.length ? '全チャットのAgentを選択してから送信できます' : 'アクティブなチャットがありません'}" aria-label="全アクティブチャットに送信">${canBroadcast ? '全アクティブチャットに送信' : '送信'}</button>
      </div>
      ${canBroadcast ? '' : `<div class="composer-hint">${activeMembers.length ? 'ヒント: 全チャットのAgentを選択するとBroadcastできます' : 'ヒント: 「+ チャット」でチャットを追加し、エージェントを選択してください'}</div>`}

      <div class="section-label">独立チャット <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${members.length}件</span></div>
      ${members.length
        ? `<div class="members">${members.map((member) => memberCard(workspace, member)).join('')}</div>`
        : `<div class="empty-inline onboarding-card">
            <div class="onboarding-icon" aria-hidden="true">✦</div>
            <p><strong>最初のワークスペースを準備しましょう</strong></p>
            <p class="small onboarding-lead">専門Agentをチャットごとに割り当て、同じ問いを並列に考えさせられます。</p>
            <div class="onboarding-steps">
              <div><b>1</b><span><strong>チャットを追加</strong><small>役割ごとのコンテキストを作成</small></span></div>
              <div><b>2</b><span><strong>Agentを選択</strong><small>安全のため明示選択を推奨</small></span></div>
              <div><b>3</b><span><strong>問いをBroadcast</strong><small>全チャットの回答を比較</small></span></div>
            </div>
            <button id="emptyAddChat" class="primary">+ 最初のチャットを追加</button>
          </div>`}

      <div class="section-label">Compile — 手動要約 <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">SETTLED時のみ実行 · 履歴には書き込まれません</span></div>
      <div class="compile">
        <div class="compile-head">
          <strong>Compile（手動）</strong>
          <div class="toolbar">
            <label for="compileAgentId" class="small" style="display:flex; align-items:center; gap:4px">コンパイルエージェント<select id="compileAgentId" aria-label="コンパイルエージェント">${agentOptionsHtml(workspace.compileAgentId, true)}</select></label>
            <button id="compile" class="sm" ${compileDisabled ? 'disabled' : ''} title="${esc(compileHint)}">コンパイルを実行</button>
          </div>
        </div>
        <label for="compilePrompt" class="field-label small">Compile Prompt <span class="scope-note">— 要約の指示（保存してから実行）</span></label>
        <textarea id="compilePrompt" placeholder="コンパイル指示 — 例: 差分を要約し、未解決点を列挙" aria-label="Compile Prompt">${esc(workspace.compilePrompt || '')}</textarea>
        ${workspace.lastCompile
          ? `<hr><div class="compile-result-head"><div class="small">${esc(workspace.lastCompile.at)}</div><div class="compile-result-actions"><button id="copyCompile" class="sm" type="button">結果をコピー</button><button id="downloadCompile" class="sm" type="button">Markdown保存</button></div></div><div class="compile-output" id="compileOutput">${esc(workspace.lastCompile.text)}</div>`
          : `<div class="small">手動のみ。${compileStateBlocked ? `現在は${workspace.runtimeState || '処理中'}のため待機中です。` : !compileAgentReady ? 'コンパイルエージェントを選択してから実行してください。' : 'コンパイル結果はチャット履歴に反映されません。' } ${compileDisabled ? '' : '<span style="color:var(--accent)">コンパイル</span>を押して要約を生成します。'}</div>`}
      </div>
    `;
    wire(workspace);
    refreshOrchestrator();
    scheduleOrchestrator();
    const gp = $('#globalPrompt'); if (gp) autoResize(gp);
    const cp = $('#compilePrompt'); if (cp) autoResize(cp);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (expectedId !== currentId) return;
    console.error(error);
    if (error.status === 404) {
      currentId = null;
      lastWorkspace = null;
      document.title = 'MultiContext Chat';
      $('#app').innerHTML = '<div class="small" style="padding:24px;text-align:center">ワークスペースが見つかりません。左の一覧から選び直してください。</div>';
      refreshList();
    } else {
      const banner = document.createElement('div');
      banner.className = 'error-banner';
      banner.setAttribute('role', 'alert');
      banner.innerHTML = `<span>更新失敗: ${esc(error.message)}</span><button class="sm" type="button" data-action="refresh-workspace">再試行</button>`;
      banner.querySelector('[data-action="refresh-workspace"]').onclick = () => {
        banner.remove();
        refresh(currentId).catch(() => {});
      };
      if (app && !app.querySelector('.error-banner')) app.prepend(banner);
      toast(`更新失敗: ${error.message}`, 'error');
    }
  } finally {
    app?.setAttribute('aria-busy', 'false');
    if (refreshController === controller) refreshController = null;
  }
}

function wire(workspace) {
  $('#refreshWorkspace').onclick = async (e) => {
    await withBusy(e.currentTarget, async () => {
      await refreshPreservingDrafts(workspace.id);
      toast('ワークスペースを更新しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };
  $('#archiveWorkspace').onclick = async (e) => {
    const action = workspace.archived ? '復元' : 'アーカイブ';
    if (!confirm(`「${workspace.name}」を${action}しますか？`)) return;
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !workspace.archived }) });
      localStorage.setItem('mcc_last_workspace', workspace.id);
      location.reload();
    }).catch((err) => toast(err.message, 'error'));
  };
  const saveBtn = $('#saveWorkspace');
  const serverVals = {
    wname: String(workspace.name || ''),
    globalPrompt: String(workspace.globalPrompt || ''),
    compileAgentId: String(workspace.compileAgentId || ''),
    compilePrompt: String(workspace.compilePrompt || ''),
    defaultAgentId: String(workspace.defaultAgentId || ''),
    agentSelectionMode: String(workspace.settings?.agentSelectionMode || 'require_selection'),
  };
  function updateDirty() {
    const cur = {
      wname: $('#wname')?.value ?? '',
      globalPrompt: $('#globalPrompt')?.value ?? '',
      compileAgentId: $('#compileAgentId')?.value ?? '',
      compilePrompt: $('#compilePrompt')?.value ?? '',
      defaultAgentId: $('#defaultAgentId')?.value ?? '',
      agentSelectionMode: $('#agentSelectionMode')?.value ?? 'require_selection',
    };
    const dirty = cur.wname !== serverVals.wname || cur.globalPrompt !== serverVals.globalPrompt || cur.compileAgentId !== serverVals.compileAgentId || cur.compilePrompt !== serverVals.compilePrompt || cur.defaultAgentId !== serverVals.defaultAgentId || cur.agentSelectionMode !== serverVals.agentSelectionMode;
    if (saveBtn) {
      saveBtn.textContent = 'ワークスペース設定を保存';
      saveBtn.classList.toggle('needs-save', dirty);
      saveBtn.title = dirty ? '未保存の変更があります — クリックで保存' : 'ワークスペース・System Prompt・Compile設定を保存';
    }
    const saveState = document.getElementById('workspaceSaveState');
    if (saveState) {
      saveState.textContent = dirty ? '未保存の変更' : '保存済み';
      saveState.className = `save-state${dirty ? ' dirty' : ''}`;
    }
    return dirty;
  }
  function updateCompileAvailability() {
    const compileButton = document.getElementById('compile');
    if (!compileButton) return;
    const ready = Boolean($('#compileAgentId')?.value || $('#defaultAgentId')?.value || agents.length === 1);
    const blockedByState = workspace.runtimeState !== 'SETTLED';
    compileButton.disabled = blockedByState || !ready;
    compileButton.title = blockedByState
      ? `コンパイルは ${workspace.runtimeState || '現在の状態'} の間は利用できません — SETTLED になるまで待ってください`
      : !ready
        ? 'Compileに使用するAgentを選択するか、ワークスペース既定Agentを設定してください'
        : '全チャットの直近メッセージを要約';
  }
  ['wname','globalPrompt','compileAgentId','compilePrompt','defaultAgentId','agentSelectionMode'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, updateDirty);
      if (id === 'compileAgentId' || id === 'defaultAgentId') el.addEventListener(ev, updateCompileAvailability);
    }
  });
  updateDirty();
  updateCompileAvailability();
  setTimeout(updateDirty, 60);
  setTimeout(updateDirty, 250);

  $('#saveWorkspace').onclick = async (e) => {
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#wname').value,
          globalPrompt: $('#globalPrompt').value,
          compileAgentId: $('#compileAgentId').value,
          compilePrompt: $('#compilePrompt').value,
          defaultAgentId: $('#defaultAgentId')?.value || '',
          settings: { agentSelectionMode: $('#agentSelectionMode')?.value || 'require_selection' },
        }),
      });
      await refreshList();
      await refreshPreservingDrafts(workspace.id);
      toast('ワークスペースを保存しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  $('#addMember').onclick = async (e) => {
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ name: `チャット ${Object.keys(workspace.members).length + 1}` }),
      });
      await refreshPreservingDrafts(workspace.id);
      toast('チャットを追加しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  const emptyAdd = $('#emptyAddChat');
  if (emptyAdd) emptyAdd.onclick = () => $('#addMember').click();

  const wname = $('#wname');
  if (wname) wname.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#saveWorkspace').click(); } });

  const gp = $('#globalPrompt');
  if (gp) { gp.addEventListener('input', () => autoResize(gp)); }

  const cp = $('#compilePrompt');
  if (cp) { cp.addEventListener('input', () => autoResize(cp)); }

  const bp = $('#broadcastPrompt');
  if (bp) {
    bp.addEventListener('input', () => autoResize(bp));
    autoResize(bp);
  }

  $('#broadcast').onclick = async (e) => {
    const prompt = $('#broadcastPrompt').value.trim();
    if (!prompt) { toast('プロンプトを入力してください', 'error'); return; }
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('is-busy')) return;
    await withBusy(btn, async () => {
      const idempotencyKey = `gui_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      await request(`/api/workspaces/${workspace.id}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt, idempotency_key: idempotencyKey }) });
      $('#broadcastPrompt').value = '';
      const ta = $('#broadcastPrompt'); if (ta) autoResize(ta);
      await refreshPreservingDrafts(workspace.id);
      toast('ブロードキャストを送信しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  const bcEl = $('#broadcastPrompt');
  if (bcEl) bcEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#broadcast').click();
    }
  });

  $('#stop').onclick = async (e) => {
    const activeCount = Object.values(workspace.members || {}).filter((member) => member.active !== false).length;
    const queuedCount = Object.values(workspace.members || {}).reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    if (!confirm(`全ての生成を停止しますか？\nアクティブなチャット${activeCount}件、待機中のキュー${queuedCount}件を停止します。`)) return;
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}/stop`, { method: 'POST', body: '{}' });
      await refreshPreservingDrafts(workspace.id);
      toast('全て停止しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  $('#deleteWorkspace').onclick = async (e) => {
    const name = String(workspace.name || 'このワークスペース');
    const memberCount = Object.keys(workspace.members || {}).length;
    const runningCount = Object.values(workspace.members || {}).filter((member) => member.inFlight).length;
    const queuedCount = Object.values(workspace.members || {}).reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    if (!confirm(`「${name}」を削除しますか？\nチャット${memberCount}件（実行中${runningCount}件、待機中${queuedCount}件）と保存済みの会話が削除されます。\nこの操作は取り消せません。`)) return;
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
      pinnedWorkspaceIds.delete(workspace.id);
      localStorage.setItem('mcc_pinned_workspaces', JSON.stringify([...pinnedWorkspaceIds]));
      if (localStorage.getItem('mcc_last_workspace') === String(workspace.id)) localStorage.removeItem('mcc_last_workspace');
      currentId = null;
      lastWorkspace = null;
      document.title = 'MultiContext Chat';
      await refreshList(null);
      $('#app').innerHTML = '<div class="empty"><div class="empty-icon" aria-hidden="true">✦</div><p><strong>ワークスペースを削除しました</strong></p><p class="small">左の一覧から別のワークスペースを選択するか、新規作成してください。</p><button id="emptyNewWorkspace" class="primary">+ 新規ワークスペースを作成</button></div>';
      document.getElementById('emptyNewWorkspace')?.addEventListener('click', () => $('#newWorkspace').click());
      toast('ワークスペースを削除しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  $('#compile').onclick = async (e) => {
    const compileSection = e.currentTarget.closest('.compile');
    await withBusy(e.currentTarget, async () => {
      e.currentTarget.textContent = '生成中…';
      compileSection?.setAttribute('aria-busy', 'true');
      await request(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ compileAgentId: $('#compileAgentId').value, compilePrompt: $('#compilePrompt').value }),
      });
      await request(`/api/workspaces/${workspace.id}/compile`, { method: 'POST', body: '{}' });
      await refreshPreservingDrafts(workspace.id);
      toast('コンパイルが完了しました', 'success');
    }).catch((err) => toast(err.message, 'error')).finally(() => {
      compileSection?.removeAttribute('aria-busy');
    });
  };

  const copyCompile = $('#copyCompile');
  if (copyCompile) copyCompile.onclick = async (e) => {
    const output = $('#compileOutput')?.textContent || '';
    try {
      if (!await copyText(output)) throw new Error('copy failed');
      const previous = e.currentTarget.textContent;
      e.currentTarget.textContent = 'コピー済み';
      toast('Compile結果をコピーしました', 'success');
      setTimeout(() => { if (e.currentTarget.isConnected) e.currentTarget.textContent = previous; }, 1400);
    } catch { toast('Compile結果のコピーに失敗しました', 'error'); }
  };
  const downloadCompile = $('#downloadCompile');
  if (downloadCompile) downloadCompile.onclick = () => {
    const output = $('#compileOutput')?.textContent || '';
    const blob = new Blob([`# ${workspace.name || 'MultiContext Compile'}\n\n${output}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${String(workspace.name || 'multicontext-report').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '') || 'multicontext-report'}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Compile結果をMarkdownで保存しました', 'success');
  };

  $$('.member').forEach((card) => {
    const memberId = card.dataset.mid;
    const member = workspace.members[memberId];
    const editor = $('.member-editor', card);
    $('[data-action=edit]', card).onclick = () => {
      const willOpen = !openEditors.has(memberId);
      if (willOpen) openEditors.add(memberId); else openEditors.delete(memberId);
      editor.classList.toggle('open', willOpen);
      card.querySelector('[data-action=edit]').setAttribute('aria-expanded', String(willOpen));
    };
    $('[data-action=copytool]', card).onclick = async (e) => {
      try {
        if (!await copyText(member.actionSpecUrl)) throw new Error('copy failed');
        toast('Action URLをコピーしました', 'success');
        const b = e.currentTarget; const prev = b.textContent; b.textContent = 'コピー済み'; setTimeout(() => b.textContent = prev, 1200);
      } catch { toast('コピーに失敗しました', 'error'); }
    };
    const stop = $('[data-action=stop]', card);
    if (stop) stop.onclick = async (e) => {
      await withBusy(e.currentTarget, async () => {
        await request(`/api/workspaces/${workspace.id}/members/${memberId}/stop`, { method: 'POST', body: '{}' });
        await refreshPreservingDrafts(workspace.id);
        toast('停止しました', 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
    const retry = $('[data-action=retry]', card);
    const trimHistory = $('[data-action=trim-history]', card);
    if (trimHistory) trimHistory.onclick = async (e) => {
      if (!confirm(`${member.name} の履歴を直近12件だけ残して整理しますか？\n現在の履歴はキューとともに保持されています。`)) return;
      await withBusy(e.currentTarget, async () => {
        const result = await request(`/api/workspaces/${workspace.id}/members/${memberId}/trim-history`, { method: 'POST', body: JSON.stringify({ max: 12 }) });
        await refreshPreservingDrafts(workspace.id);
        toast(`履歴を整理しました（${result.removed}件削除、${result.remaining}件保持）`, 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
    if (retry) retry.onclick = async (e) => {
      await withBusy(e.currentTarget, async () => {
        await request(`/api/workspaces/${workspace.id}/members/${memberId}/retry`, { method: 'POST', body: '{}' });
        await refreshPreservingDrafts(workspace.id);
        toast(`${member.name || 'チャット'} の再試行を開始しました（キューは保持されています）`, 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
    $('[data-action=direct]', card).onsubmit = async (event) => {
      event.preventDefault();
      const input = $('input', event.currentTarget);
      const btn = $('button', event.currentTarget);
      if (btn.disabled || btn.classList.contains('is-busy')) return;
      if (!input.value.trim()) { toast('プロンプトを入力してください', 'error'); return; }
      await withBusy(btn, async () => {
        await request(`/api/workspaces/${workspace.id}/members/${memberId}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: input.value }) });
        input.value = '';
        await refreshPreservingDrafts(workspace.id);
        toast('送信しました', 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
    const directInput = $('[data-action=direct] input', card);
    if (directInput) {
      directInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          $('[data-action=direct]', card).requestSubmit();
        }
      });
    }
    $('[data-action=save]', card).onclick = async (e) => {
      await withBusy(e.currentTarget, async () => {
        const body = {
          name: $('[name=name]', editor).value,
          agentId: $('[name=agentId]', editor).value,
          developerPrompt: $('[name=developerPrompt]', editor).value,
          active: $('[name=active]', editor).checked,
          canInspectOthers: $('[name=canInspectOthers]', editor).checked,
          canSendOthers: $('[name=canSendOthers]', editor).checked,
        };
        if (!body.name.trim()) { toast('チャット名を入力してください', 'error'); return; }
        await request(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify(body) });
        await refreshPreservingDrafts(workspace.id);
        toast('チャット設定を保存しました', 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
    $('[data-action=delete]', card).onclick = async (e) => {
      if (!confirm(`「${member.name}」を削除しますか？ この操作は取り消せません。`)) return;
      await withBusy(e.currentTarget, async () => {
        openEditors.delete(memberId);
        await request(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: 'DELETE' });
        await refreshPreservingDrafts(workspace.id);
        toast('チャットを削除しました', 'success');
      }).catch((err) => toast(err.message, 'error'));
    };
  });
}

// ── Sidebar drawer (mobile) ──────────────────────────────────────
const sidebar = $('#sidebar');
const overlay = $('#sidebarOverlay');
const menuBtn = $('#menuToggle');
function openSidebar() {
  sidebar?.classList.add('open');
  if (overlay) overlay.hidden = false;
  menuBtn?.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  sidebar?.classList.remove('open');
  if (overlay) overlay.hidden = true;
  menuBtn?.setAttribute('aria-expanded', 'false');
}
menuBtn?.addEventListener('click', () => {
  if (sidebar?.classList.contains('open')) closeSidebar(); else openSidebar();
});
overlay?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
document.addEventListener('keydown', (e) => {
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  if (e.key === '?' && !typing && !helpDialog?.open) {
    e.preventDefault();
    helpToggle?.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && currentId) {
    e.preventDefault();
    document.getElementById('saveWorkspace')?.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !typing) {
    e.preventDefault();
    document.getElementById('newWorkspace')?.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    workspaceSearch?.focus();
    return;
  }
  if (e.key === '/' && !typing && currentId) {
    e.preventDefault();
    document.getElementById('broadcastPrompt')?.focus();
  }
});
const workspaceSearch = $('#workspaceSearch');
workspaceSearch?.addEventListener('input', () => {
  workspaceSearchQuery = workspaceSearch.value;
  workspaceListExpanded = false;
  clearTimeout(workspaceSearchTimer);
  workspaceSearchTimer = setTimeout(() => {
    refreshList().catch((err) => toast(err.message, 'error'));
  }, 180);
});
workspaceSearch?.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !workspaceSearch.value) return;
  event.preventDefault();
  workspaceSearch.value = '';
  workspaceSearchQuery = '';
  workspaceListExpanded = false;
  clearTimeout(workspaceSearchTimer);
  refreshList().catch((err) => toast(err.message, 'error'));
});
const workspaceFilter = $('#workspaceFilter');
if (workspaceFilter) workspaceFilter.value = workspaceStatusFilter;
$('#attentionWorkspaces')?.addEventListener('click', () => {
  workspaceStatusFilter = 'BLOCKED';
  localStorage.setItem('mcc_workspace_filter', workspaceStatusFilter);
  if (workspaceFilter) workspaceFilter.value = workspaceStatusFilter;
  refreshList().catch((err) => toast(err.message, 'error'));
});
$('#archivedWorkspaces')?.addEventListener('click', () => {
  workspaceStatusFilter = 'ARCHIVED';
  localStorage.setItem('mcc_workspace_filter', workspaceStatusFilter);
  if (workspaceFilter) workspaceFilter.value = workspaceStatusFilter;
  refreshList().catch((err) => toast(err.message, 'error'));
});
workspaceFilter?.addEventListener('change', () => {
  workspaceStatusFilter = workspaceFilter.value;
  workspaceListExpanded = false;
  localStorage.setItem('mcc_workspace_filter', workspaceStatusFilter);
  refreshList().catch((err) => toast(err.message, 'error'));
});
const workspaceSortSelect = $('#workspaceSort');
if (workspaceSortSelect) workspaceSortSelect.value = workspaceSort;
workspaceSortSelect?.addEventListener('change', () => {
  workspaceSort = workspaceSortSelect.value;
  workspaceListExpanded = false;
  localStorage.setItem('mcc_workspace_sort', workspaceSort);
  refreshList().catch((err) => toast(err.message, 'error'));
});
$('#resetWorkspaceView')?.addEventListener('click', () => {
  resetWorkspaceViewState();
  refreshList().then(() => toast('表示条件をリセットしました', 'success')).catch((err) => toast(err.message, 'error'));
});

async function createWorkspaceFromDialog(name, button) {
  await withBusy(button, async () => {
    const workspace = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await select(workspace.id);
    toast('ワークスペースを作成しました', 'success');
    closeSidebar();
  });
}
$('#newWorkspace').onclick = async (e) => {
  if (isWorkspaceDirty() && currentId) {
    const ok = confirm('未保存の変更があります。破棄して新しいワークスペースを作成しますか？');
    if (!ok) return;
  }
  const dialog = $('#newWorkspaceDialog');
  const name = $('#newWorkspaceName');
  if (!dialog || !name) return toast('ワークスペース作成画面を開けませんでした', 'error');
  name.value = '';
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => name.focus(), 0);
};
const emptyNew = $('#emptyNewWorkspace');
if (emptyNew) emptyNew.onclick = () => $('#newWorkspace').click();
const newWorkspaceName = $('#newWorkspaceName');
const newWorkspaceNameCount = $('#newWorkspaceNameCount');
const updateWorkspaceNameCount = () => {
  if (newWorkspaceNameCount && newWorkspaceName) newWorkspaceNameCount.textContent = `${newWorkspaceName.value.length} / 120`;
};
newWorkspaceName?.addEventListener('input', updateWorkspaceNameCount);
$('#newWorkspaceDialog')?.addEventListener('close', () => $('#newWorkspace')?.focus());
$('#newWorkspaceForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#newWorkspaceName');
  const button = $('#createWorkspace');
  if (!name?.value.trim()) return;
  try {
    await createWorkspaceFromDialog(name.value, button);
    const dialog = $('#newWorkspaceDialog');
    if (dialog?.close) dialog.close(); else dialog?.removeAttribute('open');
  } catch (err) { toast(err.message, 'error'); }
});
$('#saveToken').onclick = () => { localStorage.setItem('mcc_token', $('#tokenInput').value); toast('トークンを保存しました', 'success'); setTimeout(() => { refreshHealth(); refreshList(); }, 0); };

initRuntimeStatus();
await Promise.all([refreshHealth(), refreshAgents(), refreshList().catch((error) => {
  const app = $('#app');
  app?.setAttribute('aria-busy', 'false');
  if (app) {
    app.innerHTML = `<div class="startup-error" role="alert"><strong>ワークスペースを読み込めませんでした</strong><span>${esc(error.message || '一時的な通信エラーです。')}</span><button id="retryStartup" class="primary" type="button">再試行</button></div>`;
    $('#retryStartup')?.addEventListener('click', () => location.reload());
  }
})]);
const savedWorkspaceId = localStorage.getItem('mcc_last_workspace');
const openLaunchWorkspace = async (workspace) => {
  if (workspace.archived) {
    workspaceStatusFilter = 'ARCHIVED';
    if (workspaceFilter) workspaceFilter.value = 'ARCHIVED';
    localStorage.setItem('mcc_workspace_filter', 'ARCHIVED');
  }
  const state = String(workspace.runtimeState || '').toUpperCase();
  if (!workspace.archived && workspaceStatusFilter !== 'all' && state !== workspaceStatusFilter) {
    workspaceStatusFilter = 'all';
    if (workspaceFilter) workspaceFilter.value = 'all';
    localStorage.setItem('mcc_workspace_filter', 'all');
  }
  await select(workspace.id);
};
if (savedWorkspaceId) {
  try {
    const { workspaces = [] } = await request('/api/workspaces?include_archived=true');
    const savedWorkspace = workspaces.find((workspace) => String(workspace.id) === savedWorkspaceId);
    if (savedWorkspace) await openLaunchWorkspace(savedWorkspace);
    else {
      localStorage.removeItem('mcc_last_workspace');
      const fallback = workspaces.filter((workspace) => !workspace.archived).slice().sort((a, b) => String(workspaceActivityTimestamp(b)).localeCompare(String(workspaceActivityTimestamp(a))))[0];
      if (fallback) await openLaunchWorkspace(fallback);
    }
  } catch {
    // Keep the last selection across transient startup/API failures.
    // It can be validated again on the next successful launch.
  }
} else {
  try {
    const { workspaces = [] } = await request('/api/workspaces?include_archived=true');
    const fallback = workspaces.filter((workspace) => !workspace.archived).slice().sort((a, b) => String(workspaceActivityTimestamp(b)).localeCompare(String(workspaceActivityTimestamp(a))))[0];
    if (fallback) await openLaunchWorkspace(fallback);
  } catch {
    // The empty state remains available when the workspace list is unavailable.
  }
}
