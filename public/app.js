import { workspaceStatusLabel as sharedWorkspaceLabel, memberStatusLabel as sharedMemberLabel } from './runtimeLabels.js';
import { pickDisplayedRun, followedRunState } from './follow-run.js';
import { selectActivityEvents } from './activity-feed.js';
import { searchEvidenceLabel } from './search-evidence.js';
import { reviewNotesHtml, openReviewDialog } from './review-notes.js';

let currentId = null;
let timer = null;
let agents = [];
let agentDiscoveryState = 'loading';
let refreshController = null;
let workspaceRetryTimer = null;
let workspaceRetryAttempt = 0;
let workspaceSearchTimer = null;
let selectedCompileIndex = 0;
const openEditors = new Set();
const openDeveloperPrompts = new Set();
const openReviewMessages = new Set();
const collapsedMembers = (() => {
  try {
    const value = JSON.parse(localStorage.getItem('mcc_collapsed_members') || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
})();
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
async function confirmDiscardUnsaved(destination = '移動') {
  const dialog = document.getElementById('unsavedDialog');
  if (!dialog) return window.confirm('未保存の変更があります。破棄して移動しますか？');
  const description = document.getElementById('unsavedDialogDescription');
  const discard = document.getElementById('discardUnsaved');
  if (description) description.textContent = `「${destination}」を続けると、ワークスペース設定やチャット設定の未保存内容は破棄されます。Escキーでも戻れます。`;
  if (discard) {
    discard.textContent = `破棄して${destination}`;
    discard.setAttribute('aria-label', `未保存の変更を破棄して${destination}`);
  }
  return new Promise((resolve) => {
    const onClose = () => resolve(dialog.returnValue === 'discard');
    dialog.addEventListener('close', onClose, { once: true });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  });
}
desktopSettings?.addEventListener('click', async () => {
  if (isWorkspaceDirty() && currentId && !(await confirmDiscardUnsaved('設定へ移動'))) return;
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
function messageRoleLabel(role) {
  const labels = { user: 'あなた', assistant: 'Agent', system: 'システム', tool: 'ツール' };
  return labels[String(role || '').toLowerCase()] || String(role || 'メッセージ');
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
function displayTimestamp(value) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return String(value || '');
  return new Date(time).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
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
function renderCompileText(value = '') {
  // Escape first: only the small, intentional Markdown subset below becomes HTML.
  const inline = (text) => text
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  const lines = esc(value).split('\n');
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] || '';
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    const isSeparator = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(next);
    if (isTableRow && isSeparator) {
      const headers = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim()));
      const rows = [];
      index += 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim())));
        index += 1;
      }
      output.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers.map((cell) => `<th scope="col">${cell}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${row[cellIndex] || ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      index -= 1;
      continue;
    }
    output.push(line
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/^###\s+(.+)$/g, '<strong class="md-heading md-heading-3">$1</strong>')
      .replace(/^##\s+(.+)$/g, '<strong class="md-heading md-heading-2">$1</strong>')
      .replace(/^#\s+(.+)$/g, '<strong class="md-heading md-heading-1">$1</strong>')
      .replace(/^---+$/g, '<span class="md-rule" aria-hidden="true"></span>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>'));
  }
  return output.join('\n');
}
const token = () => localStorage.getItem('mcc_token') || '';

// ── Toast ──────────────────────────────────────────────────────────
function toast(message, kind = '') {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
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
  const prevAriaBusy = btn.getAttribute('aria-busy');
  const prevAriaLabel = btn.getAttribute('aria-label');
  btn.classList.add('is-busy');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.setAttribute('aria-label', `${prev} — 処理中`);
  btn.textContent = '処理中…';
  const done = () => {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    btn.textContent = prev;
    if (prevAriaBusy === null) btn.removeAttribute('aria-busy');
    else btn.setAttribute('aria-busy', prevAriaBusy);
    if (prevAriaLabel === null) btn.removeAttribute('aria-label');
    else btn.setAttribute('aria-label', prevAriaLabel);
  };
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
  let response;
  try {
    response = await fetch(requestUrl, { ...options, headers });
  } catch (error) {
    recordClientDiagnostic(error, `request:${url}`);
    const err = new Error('MultiContextに接続できません。アプリの状態を確認して、もう一度再試行してください。');
    err.code = 'NETWORK_UNAVAILABLE';
    err.cause = error;
    throw err;
  }
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
    const errorCode = String(data.code || '');
    const message = {
      'Prompt is required': 'プロンプトを入力してください',
      'Unauthorized': '認証が必要です。接続設定を確認してください',
      'Invalid idempotency_key: use 1-64 chars of [A-Za-z0-9_-]': '再送識別キーの形式が不正です',
      'Idempotency key was already used for a different prompt': '同じ再送識別キーが別のプロンプトに使われています',
    }[String(rawMessage)] || ({
      AGENT_SELECTION_REQUIRED: 'Agentを選択してから送信してください。設定を開いて使用するAgentを選択してください。',
      AGENT_NOT_AVAILABLE: '設定されたAgentが利用できません。設定から利用可能なAgentを選び直してください。',
      DISCOVERY_FAILED: 'Agent一覧を取得できません。AIスタック状態から再確認してください。',
    }[errorCode] || rawMessage);
    const err = new Error(message);
    err.status = response.status;
    err.code = errorCode;
    throw err;
  }
  return data;
}

function recordClientDiagnostic(error, context = 'unknown') {
  try {
    const key = 'mcc_client_diagnostics';
    const previous = JSON.parse(sessionStorage.getItem(key) || '[]');
    previous.push({ at: new Date().toISOString(), context, message: String(error?.message || error || 'Unknown error') });
    sessionStorage.setItem(key, JSON.stringify(previous.slice(-20)));
  } catch {}
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
      if (!list || !list.length) return { text: 'AIスタック ● 確認中', cls: 'checking' };
      const states = list.map(x=>String(x.state).toLowerCase());
      const core = list.filter(x => ['モデル', 'LibreChat', 'MultiContext'].includes(x.name));
      if (core.length === 3 && core.every(x => String(x.state).toLowerCase() === 'ready') && !states.includes('error')) {
        return { text: 'AIスタック ● 準備完了', cls: 'ready' };
      }
      if (states.every(s=>s==='ready')) return { text: 'AIスタック ● 準備完了', cls: 'ready' };
      if (states.some(s=>s==='error')) return { text: 'AIスタック ● 要確認', cls: 'error' };
      if (states.some(s=>s==='checking')) return { text: 'AIスタック ● 一部確認中', cls: 'checking' };
      return { text: 'AIスタック ● 起動中', cls: 'starting' };
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
      const desktopPage = window.location.hostname === '127.0.0.1' && (Boolean(localStorage.getItem('mcc_api_base')) || new URLSearchParams(window.location.search).get('desktop_ready') === '1');
      const modelState = cachedModel?.state === 'ready' || desktopPage || window.location.hostname === '127.0.0.1' || health.ok ? 'ready' : 'checking';
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
      const desktopStartupApproved = window.location.hostname === '127.0.0.1' && (Boolean(localStorage.getItem('mcc_api_base')) || new URLSearchParams(window.location.search).get('desktop_ready') === '1');
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
    // If the stack has recovered while a workspace warning is visible, retry
    // that workspace snapshot immediately instead of waiting for the next
    // independent observer tick.
    if (health.ok && currentId && document.querySelector('#app .warning-banner')) {
      refresh(currentId).catch(() => {});
    }
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
    dialog.addEventListener('close', () => {
      btn.setAttribute('aria-expanded','false');
      btn.focus();
    });
    refreshBtn?.addEventListener('click', () => {
      refreshBtn.disabled = true;
      Promise.all([
        pollRuntime(),
        refreshAgents(currentId),
      ]).then(async () => {
        if (currentId) await refreshPreservingDrafts(currentId);
      }).catch(() => {}).finally(() => { refreshBtn.disabled = false; });
    });
    logsBtn?.addEventListener('click', async () => {
      const inv = getTauriInvoke();
      if (inv) {
        try { await inv('open_logs_dir'); toast('ログフォルダを開きました','success'); } catch (e) { toast(String(e),'error'); }
      } else {
        toast('ログはデスクトップアプリで確認できます','');
      }
    });
    document.getElementById('copyClientDiagnostics')?.addEventListener('click', async (event) => {
      const diagnostics = (() => {
        try { return JSON.parse(sessionStorage.getItem('mcc_client_diagnostics') || '[]'); } catch { return []; }
      })();
      const text = JSON.stringify({ capturedAt: new Date().toISOString(), runtime: runtimeStatuses, diagnostics }, null, 2);
      if (!await copyText(text)) { toast('診断情報のコピーに失敗しました', 'error'); return; }
      const button = event.currentTarget;
      const previous = button.textContent;
      button.textContent = 'コピー済み';
      toast('診断情報をコピーしました（会話内容は含みません）', 'success');
      setTimeout(() => { if (button.isConnected) button.textContent = previous; }, 1400);
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
  agentDiscoveryState = 'loading';
  try {
    const data = await request('/api/agents');
    if (expectedId !== currentId) return;
    agents = data.agents || [];
    agentDiscoveryState = 'ready';
  } catch {
    if (expectedId !== currentId) return;
    agents = [];
    agentDiscoveryState = 'error';
  }
}

async function refreshList(expectedId = currentId) {
  const data = await request('/api/workspaces?include_archived=true');
  if (expectedId !== currentId) return;
  const workspaces = data.workspaces || [];
  if (!currentId) {
    const app = $('#app');
    app?.setAttribute('aria-busy', 'false');
    if (app) app.innerHTML = '<div class="empty"><p><strong>ワークスペースを選択してください</strong></p><p class="small">左の一覧から選択するか、「+ 新規ワークスペース」で作成してください。MCPで作成したワークスペースも一覧に表示されます。</p></div>';
  }
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
  const filterLabels = { all: 'すべての状態', RUNNING: '実行中', PENDING: 'キューあり', BLOCKED: '要対応', SETTLED: '処理完了', ARCHIVED: 'アーカイブ済み' };
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
      : `<div class="workspace-empty" role="status"><strong>まだワークスペースがありません</strong><span class="small">チャットとAgentをまとめる場所を作成しましょう。</span><button class="sm" type="button" data-action="new-workspace-from-empty">新しいワークスペースを作成</button></div>`;
    $('#workspaces [data-action="new-workspace-from-empty"]')?.addEventListener('click', () => {
      document.getElementById('newWorkspace')?.click();
    });
    return;
  }
  if (!visibleWorkspaces.length) {
    $('#workspaces').innerHTML = `<div class="workspace-no-results" role="status" aria-live="polite">
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

async function handleWorkspaceSelect(id) {
  // Clicking the already-open workspace must never refresh away unsaved edits.
  if (id === currentId) return;
  if (isWorkspaceDirty() && currentId) {
    const ok = await confirmDiscardUnsaved('別のワークスペースへ移動');
    if (!ok) return;
  }
  return select(id);
}

async function select(id) {
  if (refreshController) refreshController.abort();
  currentId = id;
  localStorage.setItem('mcc_last_workspace', String(id));
  openEditors.clear();
  openReviewMessages.clear();
  await Promise.all([refreshList(id), refreshAgents(id)]);
  if (currentId !== id) return;
  await refresh(id);
  if (currentId !== id) return;
  scheduleNext();
}

function workspaceStatusHtml(state) {
  const { label, cls } = sharedWorkspaceLabel(state);
  return `<span class="status ${esc(cls)}" role="status" aria-label="ワークスペースの状態: ${esc(label)}" title="ランタイム状態: ${esc(label)} — 生成中/キュー/ブロックの有無のみを示し、合意や完了を意味しません">${esc(label)}</span>`;
}
function memberStatusHtml(state) {
  const { label, cls } = sharedMemberLabel(state);
  return `<span class="status ${esc(cls)}" title="チャットの状態: ${esc(label)}" aria-label="チャットの状態: ${esc(label)}">${esc(label)}</span>`;
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
  for (const id of ['wname', 'globalPrompt', 'broadcastPrompt', 'compileAgentId', 'compilePrompt', 'defaultAgentId', 'agentSelectionMode']) {
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
  for (const id of ['wname', 'globalPrompt', 'broadcastPrompt', 'compileAgentId', 'compilePrompt', 'defaultAgentId', 'agentSelectionMode']) {
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
  ['globalPrompt', 'compilePrompt', 'broadcastPrompt'].forEach((id) => {
    const textarea = document.getElementById(id);
    if (textarea) autoResize(textarea);
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
    defaultAgentId: $('#defaultAgentId')?.value ?? '',
    agentSelectionMode: $('#agentSelectionMode')?.value ?? '',
  };
  const srv = {
    wname: String(lastWorkspace.name || ''),
    globalPrompt: String(lastWorkspace.globalPrompt || ''),
    compileAgentId: String(lastWorkspace.compileAgentId || ''),
    compilePrompt: String(lastWorkspace.compilePrompt || ''),
    defaultAgentId: String(lastWorkspace.defaultAgentId || ''),
    agentSelectionMode: String(lastWorkspace.settings?.agentSelectionMode || 'require_selection'),
  };
  if (cur.wname !== srv.wname || cur.globalPrompt !== srv.globalPrompt || cur.compileAgentId !== srv.compileAgentId || cur.compilePrompt !== srv.compilePrompt || cur.defaultAgentId !== srv.defaultAgentId || cur.agentSelectionMode !== srv.agentSelectionMode) return true;
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
    for (const id of ['wname','globalPrompt','compileAgentId','compilePrompt','defaultAgentId','agentSelectionMode']) {
      const el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
    document.querySelectorAll('.member [name]').forEach((el) => {
      if (['name', 'developerPrompt'].includes(el.name)) el.dispatchEvent(new Event('input', { bubbles: true }));
      else if (['agentId', 'active', 'canInspectOthers', 'canSendOthers'].includes(el.name)) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
}

// ── Periodic tick ────────────────────────────────────────────────
let ticking = false;
function tick() {
  if (ticking) return;
  const active = document.activeElement;
  // Refreshing while a draft is focused is safe: tick snapshots and restores
  // form/scroll state below. Skipping forever here meant one transient
  // failure could leave a stale-data banner visible for the entire session.
  // Keep the normal cadence while typing to avoid visual churn.
  const hasFocusedDraft = Boolean(active && active.closest && active.closest('#app'));
  ticking = true;
  const requestedId = currentId;
  const snap = snapshotFormState();
  const scrolls = snapshotScrollPositions();
  refresh().then(() => {
    // A 404 can recover to a different workspace while refresh() is in
    // flight. Never restore the old workspace's draft into that replacement.
    if (currentId !== requestedId) return;
    restoreFormState(snap);
    restoreScrollPositions(scrolls);
    for (const id of ['wname','globalPrompt','compileAgentId','compilePrompt','defaultAgentId','agentSelectionMode']) {
      const el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
    document.querySelectorAll('.member [name]').forEach((el) => {
      if (['name', 'developerPrompt'].includes(el.name)) el.dispatchEvent(new Event('input', { bubbles: true }));
      else if (['agentId', 'active', 'canInspectOthers', 'canSendOthers'].includes(el.name)) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }).finally(() => {
    ticking = false;
    scheduleNext(hasFocusedDraft ? Math.max(observerDelay(), 5000) : undefined);
  });
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
function scheduleNext(delay) { clearTimeout(timer); timer = setTimeout(tick, delay ?? observerDelay()); }

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
    const priorityLabels = { 0: '優先度 高', 1: '優先度 標準', 2: '優先度 低' };
    const title = `${priorityLabels[p]}・待機中 (${items.length})`;
    const rows = items.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(queueStateLabels[it.state] || it.state)} ${esc(it.prompt.slice(0,80))} <span style="color:var(--text-muted)">${esc(it.origin)}/${esc(it.runId||'')}</span></div>`).join('') || '<div class="small">空です</div>';
    return `<div class="orchestrator-q-group"><div class="orchestrator-q-title">${esc(title)}</div>${rows}</div>`;
  }).join('');
  const historyItems = qHistory.slice(-10);
  const histHtml = `<div class="orchestrator-q-group"><div class="orchestrator-q-title">履歴 (${qHistory.length})</div>${historyItems.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(queueStateLabels[it.state] || it.state)} ${esc(it.prompt.slice(0,60))}</div>`).join('') || '<div class="small">空です</div>'}</div>`;
  const eventLabels = {
    'compile.started': '統合レポートの作成を開始', 'compile.completed': '統合レポートを作成', 'compile.failed': '統合レポートの作成に失敗',
    'member.started': 'メンバーの実行を開始', 'member.completed': 'メンバーの実行が完了',
    'member.failed': 'メンバーの実行に失敗', 'member.cancelled': 'メンバーをキャンセル',
    'human.retry': '再試行を開始', 'human.stop': '停止', 'human.send': '直接送信',
    'human.broadcast': '一斉送信', 'q.enqueued': '実行待ちに追加', 'q.dispatched': '実行待ちから開始',
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
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
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
  const oldestRunningAt = liveMembers
    .map(member => member.runningSince)
    .filter(Boolean)
    .sort()[0];
  const runningElapsed = oldestRunningAt
    ? Math.max(0, Math.floor((Date.now() - new Date(oldestRunningAt).getTime()) / 1000))
    : 0;
  const elapsedLabel = runningElapsed ? ` <span class="ob-elapsed" title="実行中チャットのうち最も長い経過時間">経過 ${runningElapsed}秒</span>` : '';
  const longRunningLabel = runningElapsed >= 30
    ? ' <span class="ob-long-running" title="外部ツールの継続処理を含むため、30秒以上かかっています。自動停止はせず、必要な場合だけ全て停止で中断できます">長時間実行中</span>'
    : '';
  const memberQueued = liveMembers.reduce((sum, member) => sum + (member.queue?.length || 0), 0);
  const answeredMembers = liveMembers.filter(member => (member.messages || []).some(message => message.role === 'assistant')).length;
  const progress = liveMembers.length ? Math.round((answeredMembers / liveMembers.length) * 100) : 0;
  const followTag = following && cur ? ` <span class="ob-follow" title="この実行の進行状況を表示中">◎追跡中 ${esc(cur.id.slice(0,8))}</span>` : '';
  const canPause = Boolean(data.paused || qPending.length || (cur && ['running', 'queued'].includes(cur.status)));
  const pauseLabel = data.paused ? '再開' : '一時停止';
  const pauseTitle = data.paused ? 'オーケストレーターの実行キューを再開' : canPause ? 'オーケストレーターの実行中処理とキューを一時停止' : memberQueued ? 'オーケストレーターの処理はありません。チャットの待機キューは「全て停止」で停止できます' : '実行中または待機中の処理はありません';
  const hasMemberWork = runningMembers > 0 || memberQueued > 0;
  bar.innerHTML = `
    <span class="ob-dot ${esc(dotCls)}"></span>
    <strong>実行管理</strong> <span class="ob-sep">·</span> ${esc(barStateLabels[barState] || '状態確認中')}${followTag}
    <span class="ob-sep">·</span> 優先度 高 ${q0} <span class="ob-sep">|</span> 標準 ${q1} <span class="ob-sep">|</span> 低 ${q2}${memberQueued ? ` <span class="ob-sep">·</span> チャット待機 ${memberQueued}` : ''}
    <span class="ob-sep">·</span> ${curText}${elapsedLabel}${longRunningLabel}
    <span class="ob-progress" title="現在のワークスペースで回答を保持しているチャット ${answeredMembers} / ${liveMembers.length}。過去の回答を含みます。" aria-label="回答あり ${answeredMembers} / ${liveMembers.length}${runningMembers ? `、実行中 ${runningMembers}` : ''}"><span class="ob-progress-track" aria-hidden="true"><span style="width:${progress}%"></span></span><span>回答あり ${answeredMembers}/${liveMembers.length}${runningMembers ? ` 実行中${runningMembers}` : ''}</span></span>
    <span style="flex:1"></span>
    ${hasMemberWork ? '<button class="sm danger" id="orchStopBtn" title="実行中または待機中のチャットを全て停止">全て停止</button>' : ''}
    <button class="sm" id="orchPauseBtn" ${canPause ? '' : 'disabled'} title="${esc(pauseTitle)}">${pauseLabel}</button>
    <button class="sm" id="orchQueueBtn">キューを見る</button>
  `;
  bar.querySelector('#orchStopBtn')?.addEventListener('click', () => $('#stop')?.click());
  bar.querySelector('#orchPauseBtn')?.addEventListener('click', async () => {
    await request(`/api/workspaces/${currentId}/orchestrator/pause`, { method:'POST', body: JSON.stringify({ paused: !data.paused }) });
    refreshOrchestrator();
  });
  const queueBtn = bar.querySelector('#orchQueueBtn');
  queueBtn?.setAttribute('aria-haspopup', 'dialog');
  queueBtn?.addEventListener('click', () => {
    const dlg=document.getElementById('orchestratorDrawer');
    renderOrchestratorDrawer(data);
    if (dlg && typeof dlg.showModal==='function') dlg.showModal(); else dlg?.setAttribute('open','');
  });
  const drawer = document.getElementById('orchestratorDrawer');
  const closeDrawer = document.getElementById('orchestratorClose');
  if (closeDrawer) closeDrawer.onclick = () => { if (drawer?.close) drawer.close(); else drawer?.removeAttribute('open'); };
  if (drawer) drawer.onclose = () => {
    queueBtn?.focus();
  };
}
function scheduleOrchestrator() { clearTimeout(orchestratorTimer); orchestratorTimer=setTimeout(()=>{ refreshOrchestrator().finally(scheduleOrchestrator); }, 3000); }

function memberCard(workspace, member) {
  const isCollapsed = collapsedMembers.has(String(member.id));
  const memberStateClass = member.inFlight ? ' is-processing' : member.status === 'error' ? ' needs-attention' : '';
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
  const promptOpen = openDeveloperPrompts.has(member.id) ? ' open' : '';
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
    if (m.includes('Agentが利用不可です') || m.includes('Agentが利用不可')) return `${m} 設定を開いて利用可能なAgentを選択してください。`;
    if (m.includes('Agentが未設定です')) return `${m} 設定を開いてAgentを選択してください。`;
    if (/context size|context length|too many tokens/i.test(m)) return '会話の履歴がAgentのコンテキスト上限を超えました。キューと履歴は保持されています。履歴を整理してから、もう一度再試行してください。';
    if (m.includes('peg-native format')) return 'Agentの応答形式を確認できませんでした。キューは保持されています。もう一度実行してください。';
    return m;
  })();
  const contextLimitError = /context size|context length|too many tokens/i.test(String(member.lastError || ''));
  return `
    <article class="member${isCollapsed ? ' collapsed' : ''}${memberStateClass}" data-mid="${member.id}">
      <div class="member-header">
        <div class="member-title">
          <span class="member-name">${esc(member.name)}</span>
          ${memberStatusHtml(member.status)}
        </div>
        <div class="member-actions">
          ${member.status === 'error' ? `${contextLimitError ? '<button type="button" class="sm" data-action="trim-history" title="直近12件だけを残して履歴を整理">履歴を整理</button>' : ''}<button type="button" class="sm primary" data-action="retry" title="${contextLimitError ? '履歴を整理してから、キューを保持したまま再試行' : 'キューを保持したまま再試行'}">${contextLimitError ? '整理後に再試行' : '再試行'}</button>` : ''}
          ${member.inFlight ? '<button type="button" class="sm danger" data-action="stop" title="実行中の生成を停止">停止</button>' : ''}
          ${member.messages.length ? '<button type="button" class="sm" data-action="latest" title="最新のメッセージへ移動">最新へ</button>' : ''}
          <button type="button" class="sm" data-action="toggle-collapse" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${isCollapsed ? 'チャットを展開' : 'チャットを折りたたむ'}">${isCollapsed ? '展開' : '折りたたむ'}</button>
          <button type="button" class="sm" data-action="edit" aria-expanded="${openEditors.has(member.id) ? 'true' : 'false'}" title="設定">設定</button>
          <button type="button" class="sm" data-action="copytool" title="外部連携用のURLをコピー">連携URL</button>
        </div>
      </div>
      <div class="member-meta">
        <span title="${esc(agentTitle)}">エージェント: <strong>${esc(agentLabel)}</strong></span>
        <span class="sep">·</span>
        ${queueInfo(member)}
        ${member.active === false ? '<span class="sep">·</span><span style="color:var(--text-muted)">無効</span>' : ''}
      </div>
      ${displayError ? `<div class="member-error" role="alert"><strong>処理を続行できませんでした</strong><span><b>原因:</b> ${esc(displayError)}</span><small>会話の履歴とキューは保持されています。${member.inFlight ? '実行を停止するか、' : ''}再試行できます。</small></div>` : ''}
      <div class="member-body">
        <details class="dev-prompt" data-action="prompt-details"${promptOpen}>
          <summary><span class="dev-prompt-label">役割と指示</span><span class="scope-note">Agentへのチャット固有指示</span></summary>
          <div class="dev-prompt-text">${esc(member.developerPrompt) || ''}</div>
        </details>
        <div class="member-editor${editorOpen}">
          <div class="editor-row">
            <label>名前 <input name="name" value="${esc(member.name)}" autocomplete="off"></label>
            <label>エージェント <select name="agentId">${agentOptionsHtml(member.agentId, true)}</select></label>
          </div>
          <label>チャット固有の指示<textarea name="developerPrompt" placeholder="このチャットだけに適用される指示を入力">${esc(member.developerPrompt)}</textarea></label>
          <div class="editor-row">
            <div class="check-row">
              <label><input type="checkbox" name="active" ${member.active ? 'checked' : ''}> 有効</label>
              <label><input type="checkbox" name="canInspectOthers" ${member.canInspectOthers ? 'checked' : ''}> ピアを参照</label>
              <label><input type="checkbox" name="canSendOthers" ${member.canSendOthers ? 'checked' : ''}> ピアに送信</label>
            </div>
          </div>
          <div class="editor-actions">
            <button type="button" class="sm primary" data-action="save">保存</button>
            <button type="button" class="sm danger" data-action="delete">削除</button>
          </div>
          <div class="action-url" title="${esc(member.actionSpecUrl || '')}">${esc(member.actionSpecUrl || '')}</div>
        </div>
        <div class="messages" role="log" aria-label="${esc(member.name)}のメッセージ履歴" aria-live="polite" aria-relevant="additions">
          ${member.messages.length === 0 ? '<div class="small" style="padding:12px;text-align:center">まだメッセージがありません — 一斉送信か直接送信で会話を始めましょう</div>' : ''}
          ${member.messages.map((message) => `
            <div class="msg ${esc(message.role)} ${message.pending ? 'pending-msg' : ''}">
              <div class="msg-head">${esc(messageRoleLabel(message.role))}${message.at ? ` · ${esc(displayTimestamp(message.at))}` : ''}${message.pending ? ' · 処理中' : ''}</div>
              ${message.role === 'assistant' ? `<div class="small">${esc(searchEvidenceLabel(message.searchEvidence))}</div>` : ''}
              ${renderCompileText(message.content)}
              ${message.id && !message.pending ? `${reviewNotesHtml((workspace.reviewNotes || []).filter(note => note.memberId === member.id && note.messageId === message.id), esc, { key: `${member.id}:${message.id}`, open: openReviewMessages.has(`${member.id}:${message.id}`) })}<button type="button" class="sm" data-review-message="${esc(message.id)}">検証メモを追加</button>` : ''}
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
  if (!expectedId) { await refreshList(expectedId); return; }
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const app = $('#app');
  app?.setAttribute('aria-busy', 'true');
  let snapshotFetched = false;
  try {
    const workspace = await request(`/api/workspaces/${expectedId}`, { signal: controller.signal });
    if (controller.signal.aborted || expectedId !== currentId) return;
    snapshotFetched = true;
    // A successful refresh is authoritative: remove any stale connection
    // banner before rendering the fresh snapshot so recovered connectivity is
    // visible immediately, including when the DOM was partially preserved.
    app?.querySelectorAll('.warning-banner, .error-banner').forEach((banner) => banner.remove());
    lastWorkspace = workspace;
    document.title = `${workspace.name || 'ワークスペース'} — MultiContext`;
  const members = Object.values(workspace.members);
  const activeMembers = members.filter((m) => m.active !== false);
    const setupMembers = activeMembers.filter((member) => !memberHasResolvedAgent(workspace, member));
    const blockedMembers = members.filter((m) => m.status === 'error');
    const firstBlockedMember = blockedMembers[0];
    const queuedMessages = members.reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    const runningMembers = members.filter((member) => member.inFlight).length;
    const hasWorkToStop = runningMembers > 0 || queuedMessages > 0;
    const assistantMessages = members.reduce((sum, member) => sum + (member.messages || []).filter((message) => message.role === 'assistant').length, 0);
    const agentOptions = agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}${agent.provider ? ` · ${esc(agent.provider)}` : ''}</option>`).join('');
    const allAgentsReady = activeMembers.every((member) => memberHasResolvedAgent(workspace, member));
    const canBroadcast = activeMembers.length > 0 && allAgentsReady;
    const compileStateBlocked = workspace.runtimeState !== 'SETTLED';
    const compileAgentReady = Boolean(workspace.compileAgentId || workspace.defaultAgentId || agents.length === 1);
    const compileHasSource = assistantMessages > 0;
    const compileDisabled = compileStateBlocked || !compileAgentReady || !compileHasSource;
    const archiveDisabled = !workspace.archived && ['RUNNING', 'PENDING'].includes(String(workspace.runtimeState || '').toUpperCase());
    const deleteDisabled = hasWorkToStop;
    const compileHint = compileStateBlocked
      ? `統合レポートは ${sharedWorkspaceLabel(workspace.runtimeState).label} の間は作成できません — 完了になるまで待ってください`
      : !compileAgentReady
        ? '統合レポートの作成担当を選択するか、ワークスペース既定Agentを設定してください'
        : !compileHasSource
          ? '統合レポートを作成するには、先にチャットから回答を取得してください'
        : '全チャットの直近メッセージを要約';
    const compileHistory = Array.isArray(workspace.compileHistory) && workspace.compileHistory.length
      ? workspace.compileHistory
      : (workspace.lastCompile ? [workspace.lastCompile] : []);
    selectedCompileIndex = Math.max(0, Math.min(selectedCompileIndex, Math.max(0, compileHistory.length - 1)));
    const selectedCompile = compileHistory[selectedCompileIndex] || workspace.lastCompile;
    const allMembersCollapsed = members.length > 1 && members.every((member) => collapsedMembers.has(String(member.id)));
    $('#app').innerHTML = `
      <datalist id="agentOptions">${agentOptions}</datalist>

      <div class="workspace-head">
        <div class="workspace-top">
          <div class="workspace-identity">
            <input id="wname" value="${esc(workspace.name)}" maxlength="120" aria-label="ワークスペース名" title="${esc(workspace.name)} — ワークスペース名は120文字以内です">
            ${workspaceStatusHtml(workspace.runtimeState)}${workspace.archived ? '<span class="status archived">アーカイブ済み</span>' : ''}
          </div>
          <div class="workspace-toolbar">
            <span id="workspaceSaveState" class="save-state" aria-live="polite">保存済み</span>${workspaceUpdatedLabel(workspace) ? `<span class="workspace-last-updated" title="ワークスペース保存データの最終更新時刻">保存データ: ${esc(workspaceUpdatedLabel(workspace))}</span>` : ''}<button id="refreshWorkspace" class="sm" type="button" title="ワークスペースの状態を更新" aria-label="ワークスペースの状態を更新">↻ 更新</button><button id="saveWorkspace" class="sm primary" title="ワークスペース・共通指示・統合レポート設定を保存">ワークスペース設定を保存</button>
            <button id="addMember" class="sm" title="新しいチャットを追加">+ チャット</button>
            <button id="stop" class="sm danger" ${hasWorkToStop ? '' : 'disabled'} title="${hasWorkToStop ? `実行中${runningMembers}件・キュー${queuedMessages}件を停止` : '停止する生成やキューはありません'}">全て停止</button>
            <button id="archiveWorkspace" class="sm" ${archiveDisabled ? 'disabled' : ''} title="${archiveDisabled ? '実行中またはキュー待ちのためアーカイブできません' : workspace.archived ? 'ワークスペースを通常一覧へ戻す' : 'ワークスペースをアーカイブ一覧へ移す'}">${workspace.archived ? '復元' : 'アーカイブ'}</button>
            <button id="duplicateWorkspace" class="sm" title="履歴と設定を複製して別案を作成">複製</button>
            <button id="deleteWorkspace" class="sm danger" ${deleteDisabled ? 'disabled' : ''} title="${deleteDisabled ? '実行中またはキュー待ちのため、先に全て停止してください' : 'このワークスペースを削除'}">削除</button>
          </div>
        </div>
        <div class="workspace-fields">
          <label for="globalPrompt" class="field-label">全チャット共通の指示 <span class="scope-note">— すべてのチャットに適用</span></label>
          <textarea id="globalPrompt" placeholder="全チャットに共通する指示を入力（例: 回答は簡潔にまとめる）" aria-label="全チャット共通の指示">${esc(workspace.globalPrompt)}</textarea>
          <div class="hint">指示の適用順: ワークスペース共通 → チャット固有 → 送信内容。各チャットの会話履歴は独立して保持されます。 · <span class="small">${activeMembers.length}件アクティブ / 全${members.length}件</span></div>
          <label for="defaultAgentId" class="field-label" style="margin-top:8px">既定エージェント <span class="scope-note">— 新しいチャットや「ワークスペース既定を使用」の解決先</span></label>
          <select id="defaultAgentId" aria-label="既定エージェント">${agentOptionsHtml(workspace.defaultAgentId, false)}</select>
          <label for="agentSelectionMode" class="field-label" style="margin-top:8px">Agent未指定時の選択ルール</label>
          <select id="agentSelectionMode" aria-label="Agent未指定時の選択ルール">
            <option value="require_selection" ${workspace.settings?.agentSelectionMode !== 'auto_first' ? 'selected' : ''}>明示選択を要求（安全）</option>
            <option value="auto_first" ${workspace.settings?.agentSelectionMode === 'auto_first' ? 'selected' : ''}>先頭Agentを自動選択（簡易）</option>
          </select>
          ${agents.length ? '' : agentDiscoveryState === 'error'
            ? '<div class="hint" style="color:var(--danger)">Agent一覧を取得できません。LibreChatの接続を確認し、上部の「AIスタック状態」から「再確認」を試してください。</div>'
            : '<div class="hint" style="color:var(--danger)">利用可能なAgentがありません。LibreChatでAgentを作成してください。</div>'}
        </div>
      </div>
      ${blockedMembers.length ? (() => {
        const firstError = String(firstBlockedMember?.lastError || '');
        const needsTrim = /context size|context length|too many tokens/i.test(firstError);
        const guidance = needsTrim
          ? '履歴がコンテキスト上限を超えています。対象チャットで履歴を整理して再試行してください。'
          : 'キューと履歴は保持されています。対象チャットで原因を確認して再試行できます。';
    const actionLabel = needsTrim ? '履歴整理を開く' : '対象チャットへ移動';
    return `<div class="attention-banner" role="alert"><span><strong>${blockedMembers.length}件のチャットが対応待ちです</strong><small>${guidance}</small></span><button id="focusBlocked" class="sm" type="button">${actionLabel}</button></div>`;
      })() : ''}

      <section class="workspace-overview" aria-label="ワークスペース概要">
        <div class="overview-item"><span class="overview-label">アクティブチャット</span><strong>${activeMembers.length}<small> / ${members.length} チャット</small></strong></div>
        <div class="overview-item"><span class="overview-label">実行中</span><strong class="${runningMembers ? 'has-work' : ''}">${runningMembers}<small> 件</small></strong></div>
        <div class="overview-item"><span class="overview-label">待機キュー</span><strong class="${queuedMessages ? 'has-work' : ''}">${queuedMessages}<small> 件</small></strong></div>
        <div class="overview-item"><span class="overview-label">回答数</span><strong>${assistantMessages}<small> 件</small></strong></div>
        <div class="overview-item overview-action"><span class="overview-label">統合レポート</span><strong>${workspace.lastCompile ? '利用可能' : '未作成'}</strong></div>
      </section>

      <div id="orchestratorBar" class="orchestrator-bar" style="display:none"></div>
      <dialog id="orchestratorDrawer" aria-labelledby="orchestratorDrawerTitle"><div class="orchestrator-drawer-head"><strong id="orchestratorDrawerTitle">実行管理の詳細</strong><button id="orchestratorClose" class="sm">閉じる</button></div><div id="orchestratorDrawerBody" class="orchestrator-drawer-body"><div class="small">実行状況を読み込んでいます…</div></div></dialog>
      ${setupMembers.length ? `<aside class="setup-callout" role="status"><strong>送信前にセットアップ</strong><span>${setupMembers.length}件のチャットにAgentが設定されていません。設定を開いて選択すると、送信できるようになります。</span><button type="button" class="sm primary" data-action="open-first-setup">設定を始める</button></aside>` : ''}
      <div class="section-label">一斉送信 <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${canBroadcast ? `全${activeMembers.length}件へ` : activeMembers.length ? 'Agent選択が必要です' : 'アクティブなチャットがありません'}</span></div>
      <div class="composer ${canBroadcast ? '' : 'disabled'}">
        <div style="flex:1; display:flex; flex-direction:column">
          <label for="broadcastPrompt" class="composer-label">全アクティブチャットへ <span class="scope-note">— 同じ問いを全チャットへ送信</span></label>
          <textarea id="broadcastPrompt" placeholder="${canBroadcast ? '全アクティブチャットに同じ問いを送信' : activeMembers.length ? '全チャットのAgentを選択してから送信できます' : 'チャットを追加してから一斉送信できます'}" aria-label="一斉送信の問い — 全アクティブチャットへ" ${canBroadcast ? '' : 'disabled'}></textarea>
        </div>
          <button class="primary" id="broadcast" aria-keyshortcuts="Meta+Enter" ${canBroadcast ? '' : 'disabled'} title="${canBroadcast ? '全アクティブチャットに送信' : activeMembers.length ? '全チャットのAgentを選択してから送信できます' : 'アクティブなチャットがありません'}" aria-label="全アクティブチャットに送信">${canBroadcast ? '全アクティブチャットに送信' : '送信'}</button>
      </div>
      ${canBroadcast ? '' : `<div class="composer-hint">${activeMembers.length ? 'ヒント: 全チャットのAgentを選択すると一斉送信できます' : 'ヒント: 「+ チャット」でチャットを追加し、エージェントを選択してください'}</div>`}

      <div class="section-label" role="heading" aria-level="2">独立チャット <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${members.length}件</span>${members.length > 1 ? `<button class="sm section-action" data-action="toggle-all-collapse" aria-controls="memberGrid" aria-pressed="${allMembersCollapsed}" aria-label="${allMembersCollapsed ? 'すべてのチャットを展開' : 'すべてのチャットを折りたたむ'}">${allMembersCollapsed ? 'すべて展開' : 'すべて折りたたむ'}</button>` : ''}</div>
      ${members.length
        ? `<div class="members" id="memberGrid">${members.map((member) => memberCard(workspace, member)).join('')}</div>`
        : `<div class="empty-inline onboarding-card">
            <div class="onboarding-icon" aria-hidden="true">✦</div>
            <p><strong>最初のワークスペースを準備しましょう</strong></p>
            <p class="small onboarding-lead">専門Agentをチャットごとに割り当て、同じ問いを並列に考えさせられます。</p>
            <div class="onboarding-steps">
              <div><b>1</b><span><strong>チャットを追加</strong><small>役割ごとのコンテキストを作成</small></span></div>
              <div><b>2</b><span><strong>Agentを選択</strong><small>安全のため明示選択を推奨</small></span></div>
              <div><b>3</b><span><strong>問いを一斉送信</strong><small>全チャットの回答を比較</small></span></div>
            </div>
            <button id="emptyAddChat" class="primary">+ 最初のチャットを追加</button>
          </div>`}

      <div class="section-label">統合レポート <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">完了時のみ作成 · チャット履歴には影響しません</span></div>
      <div class="compile">
        <div class="compile-head">
          <strong>回答をまとめる</strong>
          <div class="toolbar">
            <label for="compileAgentId" class="small" style="display:flex; align-items:center; gap:4px">作成担当<select id="compileAgentId" aria-label="統合レポートの作成担当">${agentOptionsHtml(workspace.compileAgentId, true)}</select></label>
            <button id="compile" class="sm" ${compileDisabled ? 'disabled' : ''} title="${esc(compileHint)}">レポートを作成</button>
          </div>
        </div>
        <label for="compilePrompt" class="field-label small">まとめ方の指示 <span class="scope-note">— レポートの作成方法（保存してから作成）</span></label>
        <textarea id="compilePrompt" placeholder="まとめ方の指示（例: 主な結論と未解決点を分けて整理）" aria-label="統合レポートのまとめ方の指示">${esc(workspace.compilePrompt || '')}</textarea>
        ${selectedCompile
          ? `<hr><div class="compile-result-head"><div class="compile-result-meta"><strong>${selectedCompileIndex === 0 ? '最新の結果' : `過去の結果 #${selectedCompileIndex}`}</strong><span class="small">${esc(displayTimestamp(selectedCompile.at))}</span><span class="small">スナップショット: ${esc(displayTimestamp(selectedCompile.snapshotAt || selectedCompile.at))}</span><span class="small">チャット数: ${selectedCompile.sourceMemberCount ?? members.filter((member) => member.messages.some((message) => message.role === 'assistant')).length} / メッセージ数: ${selectedCompile.sourceMessageCount ?? '履歴情報なし'}</span></div><div class="compile-result-actions"><button id="copyCompile" class="sm" type="button">結果をコピー</button><button id="downloadCompile" class="sm" type="button">Markdownで保存</button></div></div><div class="compile-output" id="compileOutput" role="region" aria-label="統合レポートの結果" tabindex="0">${renderCompileText(selectedCompile.text)}</div>${compileHistory.length > 1 ? `<details class="compile-history" open><summary>Compile履歴（${compileHistory.length}件）</summary><div class="small">結果を選択すると、上の表示・コピー・Markdown保存の対象が切り替わります。</div>${compileHistory.map((item, index) => `<button type="button" class="compile-history-item${index === selectedCompileIndex ? ' selected' : ''}" data-action="select-compile" data-index="${index}" aria-pressed="${index === selectedCompileIndex}"><strong>${index === 0 ? '最新' : `#${index}`}</strong><span>${esc(displayTimestamp(item.at))}</span><span>チャット数: ${item.sourceMemberCount ?? '履歴情報なし'} / メッセージ数: ${item.sourceMessageCount ?? '履歴情報なし'}</span></button>`).join('')}</details>` : ''}`
          : `<div class="small">手動のみ。${compileStateBlocked ? `現在は${workspace.runtimeState || '処理中'}のため待機中です。` : !compileAgentReady ? '作成担当を選択してから実行してください。' : '結果はチャット履歴に反映されません。' } ${compileDisabled ? '' : '<span style="color:var(--accent)">レポートを作成</span>を押して回答をまとめます。'}</div>`}
      </div>
    `;
    wire(workspace);
    refreshOrchestrator();
    scheduleOrchestrator();
    // Count a refresh as successful only after rendering and event wiring have
    // completed. A fetch can succeed while the UI update still throws.
    clearTimeout(workspaceRetryTimer);
    workspaceRetryTimer = null;
    workspaceRetryAttempt = 0;
    const gp = $('#globalPrompt'); if (gp) autoResize(gp);
    const compileOutput = $('#compileOutput');
    if (compileOutput && workspace.reviewNotes?.length && !$('#sourceReviewNotes')) {
      const records = document.createElement('details');
      records.id = 'sourceReviewNotes';
      records.open = true;
      const title = document.createElement('summary');
      title.textContent = `検証メモ原文（${workspace.reviewNotes.length}件・投稿者名は自己申告）`;
      records.append(title);
      for (const note of workspace.reviewNotes.slice(-8)) {
        const paragraph = document.createElement('p');
        paragraph.style.whiteSpace = 'pre-wrap';
        paragraph.textContent = `[${note.verdict}] ${note.reviewer} / ${note.at}\n発言: ${note.messageId}\n${note.rationale}`;
        records.append(paragraph);
      }
      if (workspace.reviewNotes.length > 8) {
        const omitted = document.createElement('p');
        omitted.textContent = '最新8件を表示しています。全記録はワークスペースデータに保存されています。';
        records.append(omitted);
      }
      compileOutput.before(records);
    }
    if (compileOutput && !$('#compileVerificationNotice')) {
      const notice = document.createElement('p');
      notice.id = 'compileVerificationNotice';
      notice.className = 'small';
      notice.textContent = '未検証の自動要約です。引用先があることと、主張が正しいことは別です。次の実行に使う前に元の発言・省略された条件を確認してください。';
      compileOutput.before(notice);
    }
    const cp = $('#compilePrompt'); if (cp) autoResize(cp);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (expectedId !== currentId) return;
    console.error(error);
    recordClientDiagnostic(error, snapshotFetched ? 'workspace-render' : 'workspace-fetch');
    if (error.status === 404) {
      currentId = null;
      lastWorkspace = null;
      document.title = 'MultiContext — 並列AIワークスペース';
      try {
        const { workspaces = [] } = await request('/api/workspaces?include_archived=true');
        const fallback = workspaces
          .filter((workspace) => !workspace.archived)
          .sort((a, b) => String(workspaceActivityTimestamp(b)).localeCompare(String(workspaceActivityTimestamp(a))))[0];
        if (fallback) {
          await select(fallback.id);
        } else {
          $('#app').innerHTML = '<div class="small" style="padding:24px;text-align:center">ワークスペースがありません。新規作成から始めてください。</div>';
          await refreshList(null);
        }
      } catch (fallbackError) {
        console.error(fallbackError);
        $('#app').innerHTML = '<div class="small" style="padding:24px;text-align:center">ワークスペースが見つかりません。左の一覧から選び直してください。</div>';
        refreshList().catch(() => {});
      }
    } else {
      const banner = document.createElement('div');
      const hasStaleData = Boolean(lastWorkspace);
      const renderFailed = snapshotFetched;
      banner.className = hasStaleData && !renderFailed ? 'warning-banner' : 'error-banner';
      banner.setAttribute('role', hasStaleData && !renderFailed ? 'status' : 'alert');
      const retryLabel = renderFailed
        ? '画面の更新に失敗しました。保存済みの内容を表示しています。'
        : '最新情報を取得できません。一時的な表示を確認中です。';
      const retryProgress = renderFailed && workspaceRetryAttempt < 3
        ? `自動で再試行しています（${workspaceRetryAttempt + 1} / 3）`
        : '再試行ボタンから、いつでも手動で更新できます。';
      const diagnostic = renderFailed
        ? `<details class="refresh-diagnostic"><summary>詳細</summary><code>${esc(error?.message || '原因を特定できませんでした')}${error?.stack ? `\n\n${esc(String(error.stack).split('\n').slice(0, 4).join('\n'))}` : ''}</code></details>`
        : '';
      banner.innerHTML = hasStaleData
        ? `<strong>${renderFailed ? '更新を完了できませんでした' : '最新情報を取得できません'}</strong><span>${retryLabel}</span><small>${retryProgress}</small>${diagnostic}<button class="sm" type="button" data-action="refresh-workspace">再試行</button>`
        : `<span>更新失敗: ${esc(error.message)}</span><button class="sm" type="button" data-action="refresh-workspace">再試行</button>`;
      banner.querySelector('[data-action="refresh-workspace"]').onclick = (event) => {
        const retry = event.currentTarget;
        if (retry.disabled) return;
        retry.disabled = true;
        retry.textContent = '再試行中…';
        retry.setAttribute('aria-busy', 'true');
        refresh(currentId).catch(() => {
          if (retry.isConnected) {
            retry.disabled = false;
            retry.textContent = '再試行';
            retry.removeAttribute('aria-busy');
          }
        });
      };
      // Keep one connection banner per workspace. The stale-data banner uses a
      // different class from the initial-load error, so checking only
      // `.error-banner` would stack a new warning on every polling tick.
      if (app && !app.querySelector('.error-banner, .warning-banner')) app.prepend(banner);
      if (!hasStaleData) toast(`更新失敗: ${error.message}`, 'error');
      if (renderFailed && expectedId === currentId && workspaceRetryAttempt < 3) {
        const delay = 2000 * (2 ** workspaceRetryAttempt);
        workspaceRetryAttempt += 1;
        clearTimeout(workspaceRetryTimer);
        workspaceRetryTimer = setTimeout(() => {
          workspaceRetryTimer = null;
          refresh(expectedId).catch(() => {});
        }, delay);
      }
    }
  } finally {
    app?.setAttribute('aria-busy', 'false');
    if (refreshController === controller) refreshController = null;
  }
}

function wire(workspace) {
  $('#focusBlocked')?.addEventListener('click', async () => {
    const target = document.querySelector('.member[data-mid] .member-error')?.closest('.member');
    if (!target) return;
    const targetId = target.dataset.mid;
    if (target.classList.contains('collapsed')) {
      collapsedMembers.delete(String(targetId));
      localStorage.setItem('mcc_collapsed_members', JSON.stringify([...collapsedMembers]));
      await refreshPreservingDrafts(workspace.id).catch((err) => toast(err.message, 'error'));
    }
    const refreshedTarget = [...document.querySelectorAll('.member')]
      .find((card) => String(card.dataset.mid) === String(targetId));
    refreshedTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const recoveryAction = refreshedTarget?.querySelector('[data-action="retry"], [data-action="trim-history"]');
    if (recoveryAction) recoveryAction.focus();
    else if (refreshedTarget) {
      refreshedTarget.setAttribute('tabindex', '-1');
      refreshedTarget.focus({ preventScroll: true });
    }
  });
  $('#refreshWorkspace')?.addEventListener('click', async (event) => {
    const e = { currentTarget: event.currentTarget };
    await withBusy(e.currentTarget, async () => {
      await refreshPreservingDrafts(workspace.id);
      toast('ワークスペースを更新しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  });
  $('#archiveWorkspace')?.addEventListener('click', async (event) => {
    const e = { currentTarget: event.currentTarget };
    const action = workspace.archived ? '復元' : 'アーカイブ';
    const unsavedWarning = isWorkspaceDirty() ? '\n未保存の変更は破棄されます。先に保存してください。' : '';
    if (!confirm(`「${workspace.name}」を${action}しますか？${unsavedWarning}`)) return;
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !workspace.archived }) });
      localStorage.setItem('mcc_last_workspace', workspace.id);
      location.reload();
    }).catch((err) => toast(err.message, 'error'));
  });
  $('#duplicateWorkspace')?.addEventListener('click', async (event) => {
    if (isWorkspaceDirty() && !(await confirmDiscardUnsaved('ワークスペースの複製'))) return;
    const name = window.prompt('複製後のワークスペース名を入力してください。', `${workspace.name}（複製）`);
    if (name === null) return;
    if (!name.trim()) return toast('ワークスペース名を入力してください', 'error');
    await withBusy(event.currentTarget, async () => {
      const copy = await request(`/api/workspaces/${workspace.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      await refreshList();
      await select(copy.id);
      toast('ワークスペースを複製しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  });
  const saveBtn = $('#saveWorkspace');
  const serverVals = {
    wname: String(workspace.name || ''),
    globalPrompt: String(workspace.globalPrompt || ''),
    compileAgentId: String(workspace.compileAgentId || ''),
    compilePrompt: String(workspace.compilePrompt || ''),
    defaultAgentId: String(workspace.defaultAgentId || ''),
    agentSelectionMode: String(workspace.settings?.agentSelectionMode || 'require_selection'),
  };
  const compileHasSource = Object.values(workspace.members || {})
    .some((member) => (member.messages || []).some((message) => message.role === 'assistant'));
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
      saveBtn.disabled = !dirty;
      saveBtn.classList.toggle('needs-save', dirty);
      saveBtn.title = dirty ? '未保存の変更があります — クリックで保存' : 'ワークスペース・共通指示・統合レポート設定を保存';
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
    compileButton.disabled = blockedByState || !ready || !compileHasSource;
    compileButton.title = blockedByState
      ? `統合レポートは ${sharedWorkspaceLabel(workspace.runtimeState).label} の間は作成できません — 完了になるまで待ってください`
      : !ready
        ? '統合レポートの作成担当を選択するか、ワークスペース既定Agentを設定してください'
        : !compileHasSource
          ? '統合レポートを作成するには、先にチャットから回答を取得してください'
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

  $('#saveWorkspace')?.addEventListener('click', async (event) => {
    const e = { currentTarget: event.currentTarget };
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
  });

  $('#addMember')?.addEventListener('click', async (event) => {
    const e = { currentTarget: event.currentTarget };
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ name: `チャット ${Object.keys(workspace.members).length + 1}` }),
      });
      await refreshPreservingDrafts(workspace.id);
      toast('チャットを追加しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  });

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

  const broadcastButton = $('#broadcast');
  if (broadcastButton) broadcastButton.onclick = async (e) => {
    const input = $('#broadcastPrompt');
    const prompt = input.value.trim();
    if (!prompt) { toast('プロンプトを入力してください', 'error'); input.focus(); return; }
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('is-busy')) return;
    await withBusy(btn, async () => {
      const idempotencyKey = `gui_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      await request(`/api/workspaces/${workspace.id}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt, idempotency_key: idempotencyKey }) });
      $('#broadcastPrompt').value = '';
      const ta = $('#broadcastPrompt'); if (ta) autoResize(ta);
      await refreshPreservingDrafts(workspace.id);
      toast('一斉送信しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  const bcEl = $('#broadcastPrompt');
  if (bcEl) bcEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#broadcast').click();
    }
  });

  const stopButton = $('#stop');
  if (stopButton) stopButton.onclick = async (e) => {
    const activeCount = Object.values(workspace.members || {}).filter((member) => member.active !== false).length;
    const queuedCount = Object.values(workspace.members || {}).reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    if (!confirm(`全ての生成を停止しますか？\nアクティブなチャット${activeCount}件、待機中のキュー${queuedCount}件を停止します。`)) return;
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}/stop`, { method: 'POST', body: '{}' });
      await refreshPreservingDrafts(workspace.id);
      toast('全て停止しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  const deleteButton = $('#deleteWorkspace');
  if (deleteButton) deleteButton.onclick = async (e) => {
    if (hasWorkToStop) {
      toast('削除する前に、実行中の生成と待機中のキューを停止してください', 'warn');
      return;
    }
    const name = String(workspace.name || 'このワークスペース');
    const memberCount = Object.keys(workspace.members || {}).length;
    const runningCount = Object.values(workspace.members || {}).filter((member) => member.inFlight).length;
    const queuedCount = Object.values(workspace.members || {}).reduce((sum, member) => sum + (member.queue?.length || 0), 0);
    const unsavedWarning = isWorkspaceDirty() ? '\n入力中の未保存変更も失われます。' : '';
    if (!confirm(`「${name}」を削除しますか？\nチャット${memberCount}件（実行中${runningCount}件、待機中${queuedCount}件）と保存済みの会話が削除されます。${unsavedWarning}\nこの操作は取り消せません。`)) return;
    const typedName = window.prompt(`削除を続けるには、ワークスペース名を正確に入力してください。\n\n${name}`);
    if (typedName === null) return;
    if (typedName !== name) {
      toast('ワークスペース名が一致しないため、削除を中止しました', 'warn');
      return;
    }
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, { method: 'DELETE', body: JSON.stringify({ confirm_name: typedName }) });
      pinnedWorkspaceIds.delete(workspace.id);
      localStorage.setItem('mcc_pinned_workspaces', JSON.stringify([...pinnedWorkspaceIds]));
      if (localStorage.getItem('mcc_last_workspace') === String(workspace.id)) localStorage.removeItem('mcc_last_workspace');
      currentId = null;
      lastWorkspace = null;
      document.title = 'MultiContext — 並列AIワークスペース';
      await refreshList(null);
      $('#app').innerHTML = '<div class="empty"><div class="empty-icon" aria-hidden="true">✦</div><p><strong>ワークスペースを削除しました</strong></p><p class="small">左の一覧から別のワークスペースを選択するか、新規作成してください。</p><button id="emptyNewWorkspace" class="primary">+ 新規ワークスペースを作成</button></div>';
      document.getElementById('emptyNewWorkspace')?.addEventListener('click', () => $('#newWorkspace').click());
      toast('ワークスペースを削除しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  const compileButton = $('#compile');
  if (compileButton) compileButton.onclick = async (e) => {
    const compileSection = e.currentTarget.closest('.compile');
    await withBusy(e.currentTarget, async () => {
      e.currentTarget.textContent = '生成中…';
      compileSection?.setAttribute('aria-busy', 'true');
      await request(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ compileAgentId: $('#compileAgentId').value, compilePrompt: $('#compilePrompt').value }),
      });
      await request(`/api/workspaces/${workspace.id}/compile`, { method: 'POST', body: '{}' });
      selectedCompileIndex = 0;
      await refreshPreservingDrafts(workspace.id);
      toast('コンパイルが完了しました', 'success');
    }).catch((err) => toast(err.message, 'error')).finally(() => {
      compileSection?.removeAttribute('aria-busy');
    });
  };

  const copyCompile = $('#copyCompile');
  if (copyCompile) copyCompile.onclick = async (e) => {
    // Copy the source Markdown so tables and intentional line breaks survive paste.
    const history = workspace.compileHistory || (workspace.lastCompile ? [workspace.lastCompile] : []);
    const output = history[selectedCompileIndex]?.text || workspace.lastCompile?.text || $('#compileOutput')?.textContent || '';
    try {
      if (!await copyText(output)) throw new Error('copy failed');
      const previous = e.currentTarget.textContent;
      e.currentTarget.textContent = 'コピー済み';
      toast('統合レポートをコピーしました', 'success');
      setTimeout(() => { if (e.currentTarget.isConnected) e.currentTarget.textContent = previous; }, 1400);
    } catch { toast('統合レポートのコピーに失敗しました', 'error'); }
  };
  const downloadCompile = $('#downloadCompile');
  if (downloadCompile) downloadCompile.onclick = () => {
    // Keep the original Markdown for export; the rendered HTML is display-only.
    const history = workspace.compileHistory || (workspace.lastCompile ? [workspace.lastCompile] : []);
    const output = history[selectedCompileIndex]?.text || workspace.lastCompile?.text || $('#compileOutput')?.textContent || '';
    const blob = new Blob([`# ${workspace.name || 'MultiContext Compile'}\n\n${output}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${String(workspace.name || 'multicontext-report').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '') || 'multicontext-report'}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('統合レポートをMarkdownで保存しました', 'success');
  };

  $$('[data-action=select-compile]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedCompileIndex = Number(button.dataset.index) || 0;
      refreshPreservingDrafts(workspace.id).catch((err) => toast(err.message, 'error'));
    });
  });

  $('[data-action=toggle-all-collapse]')?.addEventListener('click', () => {
    const ids = Object.keys(workspace.members || {}).map(String);
    if (allMembersCollapsed) ids.forEach((id) => collapsedMembers.delete(id));
    else ids.forEach((id) => collapsedMembers.add(id));
    localStorage.setItem('mcc_collapsed_members', JSON.stringify([...collapsedMembers]));
    refreshPreservingDrafts(workspace.id).catch((err) => toast(err.message, 'error'));
  });

  $('[data-action=open-first-setup]')?.addEventListener('click', () => {
    const target = Object.values(workspace.members || {}).find((member) => member.active !== false && !memberHasResolvedAgent(workspace, member));
    if (!target) return;
    openEditors.add(String(target.id));
    refreshPreservingDrafts(workspace.id).then(() => {
      const editor = document.querySelector(`.member[data-mid="${CSS.escape(String(target.id))}"] .member-editor`);
      editor?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editor?.querySelector('select[name="agentId"]')?.focus();
    }).catch((err) => toast(err.message, 'error'));
  });

  $$('.member').forEach((card) => {
    const memberId = card.dataset.mid;
    const member = workspace.members[memberId];
    $$('[data-review-key]', card).forEach(details => {
      details.addEventListener('toggle', () => {
        if (!details.isConnected) return;
        if (details.open) openReviewMessages.add(details.dataset.reviewKey);
        else openReviewMessages.delete(details.dataset.reviewKey);
      });
    });
    $$('[data-review-message]', card).forEach(button => {
      button.onclick = () => {
        const message = member.messages.find(m => m.id === button.dataset.reviewMessage && !m.pending);
        if (!message) return;
        openReviewDialog({ workspaceId: workspace.id, member, message, request, onSaved: () => {
          toast('検証メモを保存しました（原文・キューは変更していません）', 'success');
          if (currentId === workspace.id) refreshPreservingDrafts(workspace.id).catch(err => toast(`保存済みですが表示を更新できません: ${err.message}`, 'error'));
        } });
      };
    });
    const editor = $('.member-editor', card);
    const promptDetails = $('[data-action=prompt-details]', card);
    $('[data-action=latest]', card)?.addEventListener('click', () => {
      const messages = $('.messages', card);
      if (!messages) return;
      messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
      $('[data-action=latest]', card).blur();
    });
    $('[data-action=toggle-collapse]', card)?.addEventListener('click', () => {
      if (collapsedMembers.has(String(memberId))) collapsedMembers.delete(String(memberId));
      else collapsedMembers.add(String(memberId));
      localStorage.setItem('mcc_collapsed_members', JSON.stringify([...collapsedMembers]));
      refreshPreservingDrafts(workspace.id).catch((err) => toast(err.message, 'error'));
    });
    promptDetails?.addEventListener('toggle', () => {
      if (promptDetails.open) openDeveloperPrompts.add(memberId);
      else openDeveloperPrompts.delete(memberId);
    });
    const editButton = $('[data-action=edit]', card);
    if (editButton) editButton.onclick = () => {
      const willOpen = !openEditors.has(memberId);
      if (willOpen) openEditors.add(memberId); else openEditors.delete(memberId);
      editor.classList.toggle('open', willOpen);
      card.querySelector('[data-action=edit]').setAttribute('aria-expanded', String(willOpen));
    };
    const copyToolButton = $('[data-action=copytool]', card);
    if (copyToolButton) copyToolButton.onclick = async (e) => {
      try {
        if (!await copyText(member.actionSpecUrl)) throw new Error('copy failed');
        toast('外部連携用のURLをコピーしました', 'success');
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
    const directForm = $('[data-action=direct]', card);
    if (directForm) directForm.onsubmit = async (event) => {
      event.preventDefault();
      const input = $('input', event.currentTarget);
      const btn = $('button', event.currentTarget);
      if (btn.disabled || btn.classList.contains('is-busy')) return;
      if (!input.value.trim()) { toast('プロンプトを入力してください', 'error'); input.focus(); return; }
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
    const memberSave = $('[data-action=save]', card);
    const updateMemberDirty = () => {
      if (!memberSave) return false;
      const dirty = [
        ['name', String(member.name ?? '')],
        ['agentId', String(member.agentId ?? '')],
        ['developerPrompt', String(member.developerPrompt ?? '')],
      ].some(([name, value]) => $(`[name="${name}"]`, editor)?.value !== value)
        || ['active', 'canInspectOthers', 'canSendOthers'].some((name) => $(`[name="${name}"]`, editor)?.checked !== Boolean(member[name]));
      memberSave.disabled = !dirty;
      memberSave.textContent = dirty ? '変更を保存' : '保存済み';
      memberSave.title = dirty ? 'このチャットの変更を保存' : '変更はありません';
      return dirty;
    };
    ['name', 'agentId', 'developerPrompt', 'active', 'canInspectOthers', 'canSendOthers'].forEach((name) => {
      const field = $(`[name="${name}"]`, editor);
      if (field) field.addEventListener(field.type === 'checkbox' || field.tagName === 'SELECT' ? 'change' : 'input', updateMemberDirty);
    });
    updateMemberDirty();
    if (memberSave && editor) memberSave.onclick = async (e) => {
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
    const memberDelete = $('[data-action=delete]', card);
    if (memberDelete) memberDelete.onclick = async (e) => {
      const memberDraft = memberSave ? updateMemberDirty() : false;
      const unsavedWarning = memberDraft ? '\n編集中の未保存変更も失われます。先に保存してください。' : '';
      if (!confirm(`「${member.name}」を削除しますか？${unsavedWarning}\nこの操作は取り消せません。`)) return;
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
  menuBtn?.setAttribute('aria-label', 'メニューを閉じる');
}
function closeSidebar() {
  sidebar?.classList.remove('open');
  if (overlay) overlay.hidden = true;
  menuBtn?.setAttribute('aria-expanded', 'false');
  menuBtn?.setAttribute('aria-label', 'メニューを開く');
}
menuBtn?.addEventListener('click', () => {
  if (sidebar?.classList.contains('open')) closeSidebar(); else openSidebar();
});
overlay?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
document.addEventListener('keydown', (e) => {
  const target = e.target;
  if (target instanceof Element && target.closest('dialog[open]')) return;
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

async function createWorkspaceFromDialog(name, button, initialChatCount = 2) {
  await withBusy(button, async () => {
    const workspace = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim(), initial_chat_count: initialChatCount }) });
    await select(workspace.id);
    toast('ワークスペースを作成しました', 'success');
    closeSidebar();
  });
}
$('#newWorkspace').onclick = async (e) => {
  if (isWorkspaceDirty() && currentId) {
    const ok = await confirmDiscardUnsaved('新規ワークスペースの作成');
    if (!ok) return;
  }
  const dialog = $('#newWorkspaceDialog');
  const name = $('#newWorkspaceName');
  const chatCount = $('#newWorkspaceChatCount');
  if (!dialog || !name) return toast('ワークスペース作成画面を開けませんでした', 'error');
  name.value = '';
  if (chatCount) chatCount.value = '2';
  updateWorkspaceNameCount();
  updateWorkspaceChatCountHint();
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => name.focus(), 0);
};
const emptyNew = $('#emptyNewWorkspace');
if (emptyNew) emptyNew.onclick = () => $('#newWorkspace').click();
$('#cancelNewWorkspace')?.addEventListener('click', () => {
  const dialog = $('#newWorkspaceDialog');
  if (dialog?.close) dialog.close(); else dialog?.removeAttribute('open');
});
$('#newWorkspaceDialog')?.addEventListener('click', (event) => {
  if (event.target !== event.currentTarget) return;
  const dialog = event.currentTarget;
  if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
});
const newWorkspaceName = $('#newWorkspaceName');
const newWorkspaceNameCount = $('#newWorkspaceNameCount');
const newWorkspaceChatCount = $('#newWorkspaceChatCount');
const newWorkspaceChatCountHint = $('#newWorkspaceChatCountHint');
const updateWorkspaceNameCount = () => {
  if (newWorkspaceNameCount && newWorkspaceName) newWorkspaceNameCount.textContent = `${newWorkspaceName.value.length} / 120`;
};
const updateWorkspaceChatCountHint = () => {
  if (!newWorkspaceChatCountHint || !newWorkspaceChatCount) return;
  const count = Number(newWorkspaceChatCount.value || 2);
  newWorkspaceChatCountHint.textContent = count <= 2
    ? '少人数で問いを比較する構成です。作成後に各チャットへ役割とAgentを設定できます。'
    : count <= 4
      ? '複数の視点を並列に試す構成です。作成後に各チャットへ役割とAgentを設定できます。'
      : '多視点で回答を比較する構成です。実行時間とAgent使用量はチャット数に応じて増えます。';
};
newWorkspaceName?.addEventListener('input', updateWorkspaceNameCount);
newWorkspaceName?.addEventListener('input', () => newWorkspaceName.setCustomValidity(''));
newWorkspaceName?.addEventListener('invalid', () => newWorkspaceName.setCustomValidity('ワークスペース名を入力してください。'));
newWorkspaceChatCount?.addEventListener('change', updateWorkspaceChatCountHint);
$('#newWorkspaceDialog')?.addEventListener('close', () => $('#newWorkspace')?.focus());
$('#newWorkspaceForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#newWorkspaceName');
  const button = $('#createWorkspace');
  if (!name?.value.trim()) {
    toast('ワークスペース名を入力してください', 'error');
    name?.focus();
    return;
  }
  try {
    const initialChatCount = Math.max(1, Math.min(8, Number($('#newWorkspaceChatCount')?.value || 2)));
    await createWorkspaceFromDialog(name.value, button, initialChatCount);
    const dialog = $('#newWorkspaceDialog');
    if (dialog?.close) dialog.close(); else dialog?.removeAttribute('open');
  } catch (err) { toast(err.message, 'error'); }
});
$('#saveToken').onclick = () => { localStorage.setItem('mcc_token', $('#tokenInput').value); toast('トークンを保存しました', 'success'); setTimeout(() => { refreshHealth(); refreshList(); }, 0); };

initRuntimeStatus();
// Keep discovering MCP-created workspaces even before any workspace is selected.
scheduleNext();
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
