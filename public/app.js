import { workspaceStatusLabel as sharedWorkspaceLabel, memberStatusLabel as sharedMemberLabel } from './runtimeLabels.js';

let currentId = null;
let timer = null;
let agents = [];
let refreshController = null;
const openEditors = new Set();
let lastWorkspace = null; // server snapshot for dirty checks

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

function memberCard(workspace, member) {
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
  const agentLabel = member.agentId || '未設定';
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
        <span>エージェント: <strong>${esc(agentLabel)}</strong></span>
        <span class="sep">·</span>
        ${queueInfo(member)}
        ${member.active === false ? '<span class="sep">·</span><span style="color:var(--text-muted)">無効</span>' : ''}
      </div>
      ${member.lastError ? `<div class="member-error" role="alert">${esc(member.lastError)}</div>` : ''}
      <div class="member-body">
        <div class="dev-prompt">
          <div class="dev-prompt-label">Developer Prompt <span class="scope-note">— このチャットのみ</span></div>
          <div class="dev-prompt-text">${esc(member.developerPrompt) || ''}</div>
        </div>
        <div class="member-editor${editorOpen}">
          <div class="editor-row">
            <label>名前 <input name="name" value="${esc(member.name)}" autocomplete="off"></label>
            <label>エージェントID <input name="agentId" list="agentOptions" value="${esc(member.agentId)}" placeholder="agent_..."></label>
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
        </div>
      </div>

      <div class="section-label">Broadcast <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${canBroadcast ? `全${activeMembers.length}件へ` : 'アクティブなチャットがありません'}</span></div>
      <div class="composer ${canBroadcast ? '' : 'disabled'}">
        <div style="flex:1; display:flex; flex-direction:column">
          <label for="broadcastPrompt" class="composer-label">全アクティブチャットへ <span class="scope-note">— 1つのプロンプトを全チャットへ複製</span></label>
          <textarea id="broadcastPrompt" placeholder="${canBroadcast ? '全アクティブチャットに同じプロンプトを送信' : 'チャットを追加してからブロードキャストできます'}" aria-label="Broadcast プロンプト — 全アクティブチャットへ" ${canBroadcast ? '' : 'disabled'}></textarea>
        </div>
        <button class="primary" id="broadcast" ${canBroadcast ? '' : 'disabled'} title="${canBroadcast ? '全アクティブチャットに送信' : 'アクティブなチャットがありません'}" aria-label="全アクティブチャットに送信">${canBroadcast ? '全アクティブチャットに送信' : '送信'}</button>
      </div>
      ${canBroadcast ? '' : '<div class="composer-hint">ヒント: 「+ チャット」でチャットを追加し、エージェントIDを設定してください</div>'}

      <div class="section-label">独立チャット <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">${members.length}件</span></div>
      ${members.length
        ? `<div class="members">${members.map((member) => memberCard(workspace, member)).join('')}</div>`
        : '<div class="empty-inline"><p><strong>まだチャットがありません</strong></p><p class="small" style="margin:6px 0 12px">各チャットは独立したコンテキストとキューを持ち、並列に実行されます</p><button id="emptyAddChat" class="primary sm">+ 最初のチャットを追加</button></div>'}

      <div class="section-label">Compile — 手動要約 <span class="small" style="font-weight:400; text-transform:none; letter-spacing:0">SETTLED時のみ実行 · 履歴には書き込まれません</span></div>
      <div class="compile">
        <div class="compile-head">
          <strong>Compile（手動）</strong>
          <div class="toolbar">
            <label for="compileAgentId" class="small" style="display:flex; align-items:center; gap:4px">コンパイルエージェント<input id="compileAgentId" list="agentOptions" placeholder="空=最初のアクティブ" value="${esc(workspace.compileAgentId || '')}" aria-label="コンパイルエージェント"></label>
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
  };
  function updateDirty() {
    const cur = {
      wname: $('#wname')?.value ?? '',
      globalPrompt: $('#globalPrompt')?.value ?? '',
      compileAgentId: $('#compileAgentId')?.value ?? '',
      compilePrompt: $('#compilePrompt')?.value ?? '',
    };
    const dirty = cur.wname !== serverVals.wname || cur.globalPrompt !== serverVals.globalPrompt || cur.compileAgentId !== serverVals.compileAgentId || cur.compilePrompt !== serverVals.compilePrompt;
    if (saveBtn) {
      saveBtn.textContent = dirty ? 'ワークスペース設定を保存 · 未保存' : 'ワークスペース設定を保存';
      saveBtn.classList.toggle('needs-save', dirty);
      saveBtn.title = dirty ? '未保存の変更があります — クリックで保存' : 'ワークスペース・System Prompt・Compile設定を保存';
    }
    return dirty;
  }
  ['wname','globalPrompt','compileAgentId','compilePrompt'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDirty);
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
    $('[data-action=stop]', card).onclick = async (e) => {
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

await Promise.all([refreshHealth(), refreshAgents(), refreshList().catch(() => {})]);
