import { workspaceStatusLabel as sharedWorkspaceLabel, memberStatusLabel as sharedMemberLabel } from './runtimeLabels.js';

let currentId = null;
let timer = null;
let agents = [];
let refreshController = null;
const openEditors = new Set();
let lastWorkspace = null; // server snapshot for dirty checks

function agentNameForId(id) {
  if (!id) return '';
  const found = agents.find(a => String(a.id) === String(id));
  return found ? String(found.name || found.id) : String(id);
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

async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    $('#tokenDialog').showModal();
    throw new Error('Unauthorized');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || data?.error?.message || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function refreshHealth() {
  try {
    const health = await request('/api/health');
    $('#health').textContent = `LibreChat ${health.librechat.mode} · ${health.librechat.agents} エージェント · ${health.librechat.latencyMs}ms`;
    $('#health').title = `mode=${health.librechat.mode} agents=${health.librechat.agents} latency=${health.librechat.latencyMs}ms`;
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

function getTauriInvoke() {
  try {
    const t = window.__TAURI__;
    if (t && t.core && t.core.invoke) return t.core.invoke;
    if (t && t.invoke) return t.invoke;
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
      if (states.every(s=>s==='ready')) return { text: 'AI Stack ● 準備完了', cls: 'ready' };
      if (states.some(s=>s==='error')) return { text: 'AI Stack ● 要確認', cls: 'error' };
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
      }).join('');
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
    return { name: 'MCP', state: 'checking', message: '要設定', ownership: null, attempt_id: 0 };
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
      const mcState = health.ok ? 'ready' : 'error';
      const mcMsg = health.ok ? '準備完了' : (health.librechat && !health.librechat.ok ? 'LibreChat 接続を確認してください' : 'MultiContext が利用できません');
      const lcState = health.librechat && health.librechat.ok ? 'ready' : 'error';
      const lcMsg = health.librechat && health.librechat.ok ? '接続済み' : 'LibreChat 接続を確認';
      // GPT-OSS: browser cannot verify directly; Desktop runtime provides actual model health.
      const modelState = 'checking';
      const modelMsg = 'Desktop runtimeでのみ確認可能';
      base = [
        { name: 'モデル', state: modelState, message: modelMsg, ownership: null, attempt_id: 0 },
        { name: 'LibreChat', state: lcState, message: lcMsg, ownership: null, attempt_id: 0 },
        { name: 'MultiContext', state: mcState, message: mcMsg, ownership: null, attempt_id: 0 },
      ];
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
    const raw = sessionStorage.getItem('multicontext_runtime');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length >= 3) {
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
}

function workspaceDot(members) {
  const arr = Object.values(members);
  if (!arr.length) return 'idle';
  if (arr.some((m) => m.status === 'error')) return 'blocked';
  if (arr.some((m) => m.status === 'running' || m.inFlight)) return 'running';
  if (arr.some((m) => m.queue && m.queue.length)) return 'pending';
  return arr.some((m) => m.messages && m.messages.length) ? 'settled' : 'idle';
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
  const data = await request('/api/workspaces');
  if (expectedId !== currentId) return;
  const workspaces = data.workspaces || [];
  if (!workspaces.length) {
    $('#workspaces').innerHTML = '<div class="small" style="padding:8px 10px">まだワークスペースがありません</div>';
    return;
  }
  $('#workspaces').innerHTML = workspaces.map((workspace) => {
    const members = workspace.members || {};
    const count = Object.keys(members).length;
    const active = Object.values(members).filter((m) => m.active !== false).length;
    const rawState = workspace.runtimeState || null;
    const dot = rawState ? String(rawState).toLowerCase() : workspaceDot(members);
    const dotClass = dot === 'error' ? 'blocked' : dot;
    const isActive = workspace.id === currentId;
    return `<div role="listitem"><button class="workspace-link ${isActive ? 'active' : ''}" data-id="${workspace.id}" title="${esc(workspace.name)} — ${esc(rawState || dot.toUpperCase())}" aria-current="${isActive ? 'page' : 'false'}" aria-label="${esc(workspace.name)}">
      <span class="ws-dot ${esc(dotClass)}" aria-hidden="true"></span>
      <span class="ws-name">${esc(workspace.name)}</span>
      <span class="ws-count">${active}/${count}</span>
    </button></div>`;
  }).join('');
  $$('.workspace-link').forEach((button) => { button.onclick = () => { closeSidebar(); handleWorkspaceSelect(button.dataset.id); }; });
}

function handleWorkspaceSelect(id) {
  if (id === currentId) return select(id);
  if (isWorkspaceDirty() && currentId) {
    const ok = confirm('未保存の変更があります。破棄して別のワークスペースに移動しますか？');
    if (!ok) return;
  }
  return select(id);
}

async function select(id) {
  if (refreshController) refreshController.abort();
  currentId = id;
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
    if (msg) snaps[article.dataset.mid] = msg.scrollTop;
  });
  return snaps;
}

function restoreScrollPositions(snaps) {
  if (snaps._app != null) {
    const appEl = document.getElementById('app');
    if (appEl) appEl.scrollTop = snaps._app;
  }
  for (const [mid, top] of Object.entries(snaps)) {
    if (mid === '_app' || top == null) continue;
    const msg = document.querySelector(`[data-mid="${mid}"] .messages`);
    if (msg) msg.scrollTop = top;
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

function scheduleNext() { clearTimeout(timer); timer = setTimeout(tick, 1200); }

// ── Orchestrator Bar ──────────────────────────────────────────
let orchestratorTimer = null;
let orchestratorState = null;
async function refreshOrchestrator() {
  if (!currentId) return;
  try {
    const data = await request(`/api/workspaces/${currentId}/orchestrator`);
    orchestratorState = data;
    renderOrchestratorBar(data);
  } catch {}
}
function renderOrchestratorBar(data) {
  const bar = document.getElementById('orchestratorBar');
  if (!bar || !data) return;
  bar.style.display = 'flex';
  // P1 fix: only pending counts as queue, terminal goes to history
  const qAll = data.queue || [];
  const qPending = qAll.filter(x=>x.state==='pending');
  const qHistory = qAll.filter(x=>['done','failed','cancelled'].includes(x.state));
  const q0 = qPending.filter(x=>x.priority===0).length, q1=qPending.filter(x=>x.priority===1).length, q2=qPending.filter(x=>x.priority===2).length;
  const runs = data.runs || [];
  const cur = runs.find(r=>r.status==='running' || r.status==='queued') || runs[0];
  // P1 fix: derive bar state correctly (was always RUNNING)
  let barState = 'IDLE', dotCls = 'idle';
  if (data.paused) { barState = 'PAUSED'; dotCls = 'paused'; }
  else if (cur && cur.status==='running') { barState = 'RUNNING'; dotCls = 'running'; }
  else if (cur && cur.status==='queued') { barState = 'QUEUED'; dotCls = 'pending'; }
  else if (qPending.length>0) { barState = 'QUEUED'; dotCls = 'pending'; }
  else if (cur && ['blocked','failed'].includes(cur.status)) { barState = cur.status.toUpperCase(); dotCls = 'blocked'; }
  const curText = cur ? `${esc(cur.id.slice(0,4))}:${esc(cur.status)}` : '—';
  bar.innerHTML = `
    <span class="ob-dot ${esc(dotCls)}"></span>
    <strong>Orchestrator</strong> <span class="ob-sep">·</span> ${esc(barState)}
    <span class="ob-sep">·</span> Q0 ${q0} <span class="ob-sep">|</span> Q1 ${q1} <span class="ob-sep">|</span> Q2 ${q2}
    <span class="ob-sep">·</span> ${curText}
    <span style="flex:1"></span>
    <button class="sm" id="orchPauseBtn">${data.paused?'Resume':'Pause'}</button>
    <button class="sm" id="orchQueueBtn">Queue</button>
  `;
  bar.querySelector('#orchPauseBtn')?.addEventListener('click', async () => {
    await request(`/api/workspaces/${currentId}/orchestrator/pause`, { method:'POST', body: JSON.stringify({ paused: !data.paused }) });
    refreshOrchestrator();
  });
  bar.querySelector('#orchQueueBtn')?.addEventListener('click', () => {
    const dlg=document.getElementById('orchestratorDrawer');
    const body=document.getElementById('orchestratorDrawerBody');
    if (body) {
      // Use textContent via DOM to avoid XSS, fallback to esc
      const pendingHtml = [0,1,2].map(p=>{
        const items=qPending.filter(x=>x.priority===p);
        const title = `Q${p} pending (${items.length})`;
        const rows = items.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(it.state)} ${esc(it.prompt.slice(0,80))} <span style="color:var(--text-muted)">${esc(it.origin)}/${esc(it.runId||'')}</span></div>`).join('') || '<div class="small">empty</div>';
        return `<div class="orchestrator-q-group"><div class="orchestrator-q-title">${esc(title)}</div>${rows}</div>`;
      }).join('');
      const historyItems = qHistory.slice(-10);
      const histHtml = `<div class="orchestrator-q-group"><div class="orchestrator-q-title">History (${qHistory.length})</div>${historyItems.map(it=>`<div class="orchestrator-event ${esc(it.origin)}">${esc(it.state)} ${esc(it.prompt.slice(0,60))}</div>`).join('') || '<div class="small">empty</div>'}</div>`;
      const evHtml = (data.events||[]).slice(-20).reverse().map(e=>`<div class="orchestrator-event ${esc(e.origin)}">${esc(e.ts.slice(11,19))} ${esc(e.type)} <span style="color:var(--text-muted)">${esc(e.origin)}${e.actor?'/'+esc(e.actor):''}</span></div>`).join('');
      body.innerHTML = pendingHtml + histHtml + `<div class="orchestrator-q-group"><div class="orchestrator-q-title">Events</div>${evHtml || '<div class="small">no events</div>'}</div>`;
    }
    if (dlg && typeof dlg.showModal==='function') dlg.showModal(); else dlg?.setAttribute('open','');
  });
  document.getElementById('orchestratorClose')?.addEventListener('click', ()=>{ const d=document.getElementById('orchestratorDrawer'); if(d.close) d.close(); else d.removeAttribute('open'); });
}
function scheduleOrchestrator() { clearTimeout(orchestratorTimer); orchestratorTimer=setTimeout(()=>{ refreshOrchestrator().finally(scheduleOrchestrator); }, 3000); }

function memberCard(workspace, member) {
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
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
    return m;
  })();
  return `
    <article class="member" data-mid="${member.id}">
      <div class="member-header">
        <div class="member-title">
          <span class="member-name">${esc(member.name)}</span>
          ${memberStatusHtml(member.status)}
        </div>
        <div class="member-actions">
          ${member.status === 'error' ? '<button class="sm" data-action="retry" title="ブロックを解除して再試行">リトライ</button>' : ''}
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
      ${displayError ? `<div class="member-error" role="alert">${esc(displayError)}</div>` : ''}
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
            <input placeholder="プロンプトを入力 — ⌘+↵" aria-label="このチャットだけに送信するプロンプト" ${member.active ? '' : 'disabled'}>
            <button class="sm primary" ${member.active ? '' : 'disabled'} title="このチャットだけに送信" aria-label="このチャットだけに送信">送信</button>
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
  try {
    const workspace = await request(`/api/workspaces/${expectedId}`, { signal: controller.signal });
    if (controller.signal.aborted || expectedId !== currentId) return;
    lastWorkspace = workspace;
    const members = Object.values(workspace.members);
    const activeMembers = members.filter((m) => m.active !== false);
    const agentOptions = agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}${agent.provider ? ` · ${esc(agent.provider)}` : ''}</option>`).join('');
    const canBroadcast = activeMembers.length > 0;
    const compileDisabled = workspace.runtimeState !== 'SETTLED';
    const compileHint = compileDisabled ? `コンパイルは ${workspace.runtimeState} の間は利用できません — SETTLED になるまで待ってください` : '全チャットの直近メッセージを要約';
    $('#app').innerHTML = `
      <datalist id="agentOptions">${agentOptions}</datalist>

      <div class="workspace-head">
        <div class="workspace-top">
          <div class="workspace-identity">
            <input id="wname" value="${esc(workspace.name)}" aria-label="ワークスペース名">
            ${workspaceStatusHtml(workspace.runtimeState)}
          </div>
          <div class="workspace-toolbar">
            <button id="saveWorkspace" class="sm primary" title="ワークスペース・System Prompt・Compile設定を保存">ワークスペース設定を保存</button>
            <button id="addMember" class="sm" title="新しいチャットを追加">+ チャット</button>
            <button id="stop" class="sm danger" title="全チャットの生成とキューを停止">全て停止</button>
          </div>
        </div>
        <div class="workspace-fields">
          <label for="globalPrompt" class="field-label">共有 System Prompt <span class="scope-note">— 全チャットに system role として適用</span></label>
          <textarea id="globalPrompt" placeholder="全チャット共通の system 指示を入力（例: あなたは簡潔に答えるアシスタントです）" aria-label="共有 System Prompt">${esc(workspace.globalPrompt)}</textarea>
          <div class="hint">指示階層: System Prompt（共有） → Developer Prompt（チャット固有） → user（Broadcast / Direct）。nativeはLibreChat会話を継続、compatはローカル履歴を再生。 · <span class="small">${activeMembers.length}件アクティブ / 全${members.length}件</span></div>
          <label for="defaultAgentId" class="field-label" style="margin-top:8px">既定エージェント <span class="scope-note">— 新しいチャットや「ワークスペース既定を使用」の解決先</span></label>
          <select id="defaultAgentId" aria-label="既定エージェント">${agentOptionsHtml(workspace.defaultAgentId, false)}</select>
          ${agents.length ? '' : '<div class="hint" style="color:var(--danger)">利用可能なAgentがありません。LibreChatでAgentを作成してください。</div>'}
        </div>
      </div>

      <div id="orchestratorBar" class="orchestrator-bar" style="display:none"></div>
      <dialog id="orchestratorDrawer"><div class="orchestrator-drawer-head"><strong>Orchestrator</strong><button id="orchestratorClose" class="sm">閉じる</button></div><div id="orchestratorDrawerBody" class="orchestrator-drawer-body"><div class="small">読み込み中...</div></div></dialog>
      <div class="section-label">Broadcast <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${canBroadcast ? `全${activeMembers.length}件へ` : 'アクティブなチャットがありません'}</span></div>
      <div class="composer ${canBroadcast ? '' : 'disabled'}">
        <div style="flex:1; display:flex; flex-direction:column">
          <label for="broadcastPrompt" class="composer-label">全アクティブチャットへ <span class="scope-note">— 1つのプロンプトを全チャットへ複製</span></label>
          <textarea id="broadcastPrompt" placeholder="${canBroadcast ? '全アクティブチャットに同じプロンプトを送信' : 'チャットを追加してからブロードキャストできます'}" aria-label="Broadcast プロンプト — 全アクティブチャットへ" ${canBroadcast ? '' : 'disabled'}></textarea>
        </div>
        <button class="primary" id="broadcast" ${canBroadcast ? '' : 'disabled'} title="${canBroadcast ? '全アクティブチャットに送信' : 'アクティブなチャットがありません'}" aria-label="全アクティブチャットに送信">${canBroadcast ? '全アクティブチャットに送信' : '送信'}</button>
      </div>
      ${canBroadcast ? '' : '<div class="composer-hint">ヒント: 「+ チャット」でチャットを追加し、エージェントを選択してください</div>'}

      <div class="section-label">独立チャット <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${members.length}件</span></div>
      ${members.length
        ? `<div class="members">${members.map((member) => memberCard(workspace, member)).join('')}</div>`
        : '<div class="empty-inline"><p><strong>まだチャットがありません</strong></p><p class="small" style="margin:6px 0 12px">各チャットは独立したコンテキストとキューを持ち、並列に実行されます</p><button id="emptyAddChat" class="primary sm">+ 最初のチャットを追加</button></div>'}

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
          ? `<hr><div class="small">${esc(workspace.lastCompile.at)}</div><div class="compile-output">${esc(workspace.lastCompile.text)}</div>`
          : `<div class="small">手動のみ。${compileDisabled ? `現在は${workspace.runtimeState}のため待機中です。` : 'コンパイル結果はチャット履歴に反映されません。' } ${compileDisabled ? '' : '<span style="color:var(--accent)">コンパイル</span>を押して要約を生成します。'}</div>`}
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
      $('#app').innerHTML = '<div class="small" style="padding:24px;text-align:center">ワークスペースが見つかりません。左の一覧から選び直してください。</div>';
      refreshList();
    } else {
      const banner = document.createElement('div');
      banner.className = 'error-banner';
      banner.setAttribute('role', 'alert');
      banner.textContent = `更新失敗: ${error.message}`;
      const app = $('#app');
      if (app && !app.querySelector('.error-banner')) app.prepend(banner);
      toast(`更新失敗: ${error.message}`, 'error');
    }
  } finally {
    if (refreshController === controller) refreshController = null;
  }
}

function wire(workspace) {
  const saveBtn = $('#saveWorkspace');
  const serverVals = {
    wname: String(workspace.name || ''),
    globalPrompt: String(workspace.globalPrompt || ''),
    compileAgentId: String(workspace.compileAgentId || ''),
    compilePrompt: String(workspace.compilePrompt || ''),
    defaultAgentId: String(workspace.defaultAgentId || ''),
  };
  function updateDirty() {
    const cur = {
      wname: $('#wname')?.value ?? '',
      globalPrompt: $('#globalPrompt')?.value ?? '',
      compileAgentId: $('#compileAgentId')?.value ?? '',
      compilePrompt: $('#compilePrompt')?.value ?? '',
      defaultAgentId: $('#defaultAgentId')?.value ?? '',
    };
    const dirty = cur.wname !== serverVals.wname || cur.globalPrompt !== serverVals.globalPrompt || cur.compileAgentId !== serverVals.compileAgentId || cur.compilePrompt !== serverVals.compilePrompt || cur.defaultAgentId !== serverVals.defaultAgentId;
    if (saveBtn) {
      saveBtn.textContent = dirty ? 'ワークスペース設定を保存 · 未保存' : 'ワークスペース設定を保存';
      saveBtn.classList.toggle('needs-save', dirty);
      saveBtn.title = dirty ? '未保存の変更があります — クリックで保存' : 'ワークスペース・System Prompt・Compile設定を保存';
    }
    return dirty;
  }
  ['wname','globalPrompt','compileAgentId','compilePrompt','defaultAgentId'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, updateDirty);
    }
  });
  updateDirty();
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
      await request(`/api/workspaces/${workspace.id}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt }) });
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
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}/stop`, { method: 'POST', body: '{}' });
      await refreshPreservingDrafts(workspace.id);
      toast('全て停止しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
  };

  $('#compile').onclick = async (e) => {
    await withBusy(e.currentTarget, async () => {
      await request(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ compileAgentId: $('#compileAgentId').value, compilePrompt: $('#compilePrompt').value }),
      });
      await request(`/api/workspaces/${workspace.id}/compile`, { method: 'POST', body: '{}' });
      await refreshPreservingDrafts(workspace.id);
      toast('コンパイルが完了しました', 'success');
    }).catch((err) => toast(err.message, 'error'));
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
        await navigator.clipboard.writeText(member.actionSpecUrl);
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
    if (retry) retry.onclick = async (e) => {
      await withBusy(e.currentTarget, async () => {
        await request(`/api/workspaces/${workspace.id}/members/${memberId}/retry`, { method: 'POST', body: '{}' });
        await refreshPreservingDrafts(workspace.id);
        toast('リトライを開始しました', 'success');
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

$('#newWorkspace').onclick = async (e) => {
  if (isWorkspaceDirty() && currentId) {
    const ok = confirm('未保存の変更があります。破棄して新しいワークスペースを作成しますか？');
    if (!ok) return;
  }
  await withBusy(e.currentTarget, async () => {
    const workspace = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '新しいワークスペース' }) });
    await select(workspace.id);
    toast('ワークスペースを作成しました', 'success');
    closeSidebar();
  }).catch((err) => toast(err.message, 'error'));
};
const emptyNew = $('#emptyNewWorkspace');
if (emptyNew) emptyNew.onclick = () => $('#newWorkspace').click();
$('#saveToken').onclick = () => { localStorage.setItem('mcc_token', $('#tokenInput').value); toast('トークンを保存しました', 'success'); setTimeout(() => { refreshHealth(); refreshList(); }, 0); };

initRuntimeStatus();
await Promise.all([refreshHealth(), refreshAgents(), refreshList().catch(() => {})]);
