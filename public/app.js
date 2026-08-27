let currentId = null;
let timer = null;
let agents = [];
let refreshController = null;
const openEditors = new Set();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const token = () => localStorage.getItem('mcc_token') || '';

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
    $('#health').textContent = `LibreChat ${health.librechat.mode} · ${health.librechat.agents} agents · ${health.librechat.latencyMs}ms`;
  } catch (error) {
    $('#health').textContent = `LibreChat unavailable · ${error.message}`;
  }
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
  $('#workspaces').innerHTML = data.workspaces.map((workspace) => `
    <button class="workspace-link ${workspace.id === currentId ? 'active' : ''}" data-id="${workspace.id}">${esc(workspace.name)}</button>
  `).join('');
  $$('.workspace-link').forEach((button) => { button.onclick = () => select(button.dataset.id); });
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

function statusLabel(state) {
  const label = state === 'error' ? 'BLOCKED' : state.toUpperCase();
  return `<span class="status ${esc(state === 'error' ? 'blocked' : state)}">${esc(label)}</span>`;
}

function queueInfo(member) {
  const count = member.queue.length;
  const inFlight = member.inFlight ? 1 : 0;
  const cls = count > 0 || inFlight ? 'queue-badge has-items' : 'queue-badge';
  const parts = [];
  if (inFlight) parts.push('processing');
  if (count > 0) parts.push(`${count} queued`);
  if (!parts.length) parts.push('idle');
  return `<span class="${cls}">${parts.join(' · ')}</span>`;
}

// ── Snapshot / restore form state across refresh ────────────────
function snapshotFormState() {
  const snap = {};
  for (const id of ['wname', 'globalPrompt', 'broadcastPrompt', 'compileAgentId', 'compilePrompt']) {
    const el = document.getElementById(id);
    if (el) snap[id] = el.value;
  }
  // Per-member editor fields
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
  }).finally(() => { ticking = false; scheduleNext(); });
}

function scheduleNext() { clearTimeout(timer); timer = setTimeout(tick, 1200); }

function memberCard(workspace, member) {
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
  const agentLabel = member.agentId || 'unset';
  return `
    <article class="member" data-mid="${member.id}">
      <div class="member-header">
        <div class="member-title">
          <span class="member-name">${esc(member.name)}</span>
          ${statusLabel(member.status)}
        </div>
        <div class="member-actions">
          ${member.status === 'error' ? '<button class="sm" data-action="retry">Retry</button>' : ''}
          ${member.inFlight ? '<button class="sm danger" data-action="stop">Stop</button>' : ''}
          <button class="sm" data-action="edit" title="Configure">Settings</button>
          <button class="sm" data-action="copytool" title="Copy Action URL">URL</button>
        </div>
      </div>
      <div class="member-meta">
        <span>Agent: <strong>${esc(agentLabel)}</strong></span>
        <span class="sep">·</span>
        ${queueInfo(member)}
        ${member.active === false ? '<span class="sep">·</span><span style="color:var(--text-muted)">inactive</span>' : ''}
      </div>
      ${member.lastError ? `<div class="member-error">${esc(member.lastError)}</div>` : ''}
      <div class="member-body">
        <div class="dev-prompt">
          <div class="dev-prompt-label">Developer prompt</div>
          <div class="dev-prompt-text">${esc(member.developerPrompt) || ''}</div>
        </div>
        <div class="member-editor${editorOpen}">
          <div class="editor-row">
            <label>Name <input name="name" value="${esc(member.name)}"></label>
            <label>Agent ID <input name="agentId" list="agentOptions" value="${esc(member.agentId)}"></label>
          </div>
          <label>Developer instructions<textarea name="developerPrompt">${esc(member.developerPrompt)}</textarea></label>
          <div class="editor-row">
            <div class="check-row">
              <label><input type="checkbox" name="active" ${member.active ? 'checked' : ''}> Active</label>
              <label><input type="checkbox" name="canInspectOthers" ${member.canInspectOthers ? 'checked' : ''}> Inspect peers</label>
              <label><input type="checkbox" name="canSendOthers" ${member.canSendOthers ? 'checked' : ''}> Send to peers</label>
            </div>
          </div>
          <div class="editor-actions">
            <button class="sm primary" data-action="save">Save</button>
            <button class="sm danger" data-action="delete">Delete</button>
          </div>
          <div class="action-url">${esc(member.actionSpecUrl || '')}</div>
        </div>
        <div class="messages">
          ${member.messages.length === 0 ? '<div class="small" style="padding:12px;text-align:center">No messages yet</div>' : ''}
          ${member.messages.map((message) => `
            <div class="msg ${esc(message.role)} ${message.pending ? 'pending-msg' : ''}">
              <div class="msg-head">${esc(message.role)}${message.at ? ` · ${esc(message.at)}` : ''}${message.pending ? ' · pending' : ''}</div>
              ${esc(message.content)}
            </div>
          `).join('')}
        </div>
        <div class="member-footer">
          <form data-action="direct">
            <input placeholder="Prompt this chat" ${member.active ? '' : 'disabled'}>
            <button class="sm primary" ${member.active ? '' : 'disabled'}>Send</button>
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
    const members = Object.values(workspace.members);
    const agentOptions = agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}${agent.provider ? ` · ${esc(agent.provider)}` : ''}</option>`).join('');
    $('#app').innerHTML = `
      <datalist id="agentOptions">${agentOptions}</datalist>

      <div class="workspace-head">
        <div class="workspace-top">
          <div class="workspace-identity">
            <input id="wname" value="${esc(workspace.name)}">
            ${statusLabel(workspace.runtimeState)}
          </div>
          <div class="workspace-toolbar">
            <button id="saveWorkspace" class="sm primary">Save</button>
            <button id="addMember" class="sm">+ Chat</button>
            <button id="stop" class="sm danger">Stop all</button>
          </div>
        </div>
        <div class="workspace-fields">
          <textarea id="globalPrompt" placeholder="Shared system prompt — applied to all chats as the system message">${esc(workspace.globalPrompt)}</textarea>
          <div class="hint">Instruction hierarchy: system → developer → user. Native mode requires the documented LibreChat patch; compat mode replays isolated local history.</div>
        </div>
      </div>

      <div class="section-label">Broadcast</div>
      <div class="composer">
        <textarea id="broadcastPrompt" placeholder="One prompt → every active independent chat"></textarea>
        <button class="primary" id="broadcast">Broadcast</button>
      </div>

      <div class="section-label">Independent chats</div>
      ${members.length
        ? `<div class="members">${members.map((member) => memberCard(workspace, member)).join('')}</div>`
        : '<div class="empty-inline">No chats yet. Click <strong>+ Chat</strong> to add an independent chat.</div>'}

      <div class="section-label">Compile</div>
      <div class="compile">
        <div class="compile-head">
          <strong>Response compression</strong>
          <div class="toolbar">
            <input id="compileAgentId" list="agentOptions" placeholder="Compiler agent (blank = first active)" value="${esc(workspace.compileAgentId || '')}">
            <button id="compile" class="sm" ${workspace.runtimeState === 'SETTLED' ? '' : 'disabled'}>Compile</button>
          </div>
        </div>
        <textarea id="compilePrompt" placeholder="Compile instructions">${esc(workspace.compilePrompt || '')}</textarea>
        ${workspace.lastCompile
          ? `<hr><div class="small">${esc(workspace.lastCompile.at)}</div><div class="compile-output">${esc(workspace.lastCompile.text)}</div>`
          : '<div class="small">Manual only. Compile never feeds its result back into member histories.</div>'}
      </div>
    `;
    wire(workspace);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (expectedId !== currentId) return;
    console.error(error);
    if (error.status === 404) {
      currentId = null;
      $('#app').innerHTML = '<div class="small" style="padding:24px;text-align:center">Workspace not found.</div>';
      refreshList();
    } else {
      const banner = document.createElement('div');
      banner.className = 'error-banner';
      banner.textContent = `Refresh failed: ${error.message}`;
      const app = $('#app');
      if (app && !app.querySelector('.error-banner')) app.prepend(banner);
    }
  } finally {
    if (refreshController === controller) refreshController = null;
  }
}

function wire(workspace) {
  $('#saveWorkspace').onclick = async () => {
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
    await refresh();
  };

  $('#addMember').onclick = async () => {
    await request(`/api/workspaces/${workspace.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ name: `Agent ${Object.keys(workspace.members).length + 1}` }),
    });
    await refresh();
  };

  $('#broadcast').onclick = async () => {
    const prompt = $('#broadcastPrompt').value.trim();
    if (!prompt) return;
    try {
      await request(`/api/workspaces/${workspace.id}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt }) });
      $('#broadcastPrompt').value = '';
      await refresh();
    } catch (error) { alert(error.message); }
  };

  // Cmd/Ctrl+Enter to broadcast
  $('#broadcastPrompt').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#broadcast').click();
    }
  });

  $('#stop').onclick = async () => {
    await request(`/api/workspaces/${workspace.id}/stop`, { method: 'POST', body: '{}' });
    await refresh();
  };

  $('#compile').onclick = async () => {
    try {
      await request(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ compileAgentId: $('#compileAgentId').value, compilePrompt: $('#compilePrompt').value }),
      });
      await request(`/api/workspaces/${workspace.id}/compile`, { method: 'POST', body: '{}' });
      await refresh();
    } catch (error) { alert(error.message); }
  };

  $$('.member').forEach((card) => {
    const memberId = card.dataset.mid;
    const member = workspace.members[memberId];
    const editor = $('.member-editor', card);
    $('[data-action=edit]', card).onclick = () => {
      if (openEditors.has(memberId)) openEditors.delete(memberId); else openEditors.add(memberId);
      editor.classList.toggle('open');
    };
    $('[data-action=copytool]', card).onclick = async () => {
      await navigator.clipboard.writeText(member.actionSpecUrl);
      alert('Action URL copied');
    };
    $('[data-action=stop]', card).onclick = async () => {
      await request(`/api/workspaces/${workspace.id}/members/${memberId}/stop`, { method: 'POST', body: '{}' });
      await refresh();
    };
    const retry = $('[data-action=retry]', card);
    if (retry) retry.onclick = async () => {
      await request(`/api/workspaces/${workspace.id}/members/${memberId}/retry`, { method: 'POST', body: '{}' });
      await refresh();
    };
    $('[data-action=direct]', card).onsubmit = async (event) => {
      event.preventDefault();
      const input = $('input', event.currentTarget);
      if (!input.value.trim()) return;
      try {
        await request(`/api/workspaces/${workspace.id}/members/${memberId}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: input.value }) });
        input.value = '';
        await refresh();
      } catch (error) { alert(error.message); }
    };
    // Cmd/Ctrl+Enter to send direct prompt
    const directInput = $('[data-action=direct] input', card);
    if (directInput) {
      directInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          $('[data-action=direct]', card).requestSubmit();
        }
      });
    }
    $('[data-action=save]', card).onclick = async () => {
      const body = {
        name: $('[name=name]', editor).value,
        agentId: $('[name=agentId]', editor).value,
        developerPrompt: $('[name=developerPrompt]', editor).value,
        active: $('[name=active]', editor).checked,
        canInspectOthers: $('[name=canInspectOthers]', editor).checked,
        canSendOthers: $('[name=canSendOthers]', editor).checked,
      };
      await request(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify(body) });
      await refresh();
    };
    $('[data-action=delete]', card).onclick = async () => {
      if (!confirm('Delete this independent chat?')) return;
      openEditors.delete(memberId);
      await request(`/api/workspaces/${workspace.id}/members/${memberId}`, { method: 'DELETE' });
      await refresh();
    };
  });
}

$('#newWorkspace').onclick = async () => {
  const workspace = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'MultiContext Workspace' }) });
  await select(workspace.id);
};
$('#saveToken').onclick = () => { localStorage.setItem('mcc_token', $('#tokenInput').value); setTimeout(() => { refreshHealth(); refreshList(); }, 0); };

await Promise.all([refreshHealth(), refreshAgents(), refreshList().catch(() => {})]);
