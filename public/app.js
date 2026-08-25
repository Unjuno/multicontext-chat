let currentId = null;
let timer = null;
let agents = [];
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
  if (!response.ok) throw new Error(data.error || data?.error?.message || `HTTP ${response.status}`);
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

async function refreshAgents() {
  try {
    const data = await request('/api/agents');
    agents = data.agents || [];
  } catch {
    agents = [];
  }
}

async function refreshList() {
  const data = await request('/api/workspaces');
  $('#workspaces').innerHTML = data.workspaces.map((workspace) => `
    <button class="workspace-link ${workspace.id === currentId ? 'active' : ''}" data-id="${workspace.id}">${esc(workspace.name)}</button>
  `).join('');
  $$('.workspace-link').forEach((button) => { button.onclick = () => select(button.dataset.id); });
}

async function select(id) {
  currentId = id;
  openEditors.clear();
  await Promise.all([refreshList(), refreshAgents()]);
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') refresh();
  }, 1200);
}

function memberCard(workspace, member) {
  const status = member.status === 'error' ? 'blocked' : member.status;
  const current = member.current ? ' · in-flight' : '';
  const editorOpen = openEditors.has(member.id) ? ' open' : '';
  return `
    <article class="member" data-mid="${member.id}">
      <header>
        <div>
          <strong>${esc(member.name)}</strong>
          <span class="status ${esc(status)}">${esc(member.status === 'error' ? 'BLOCKED' : member.status.toUpperCase())}</span>
          <div class="meta">queue ${member.queue.length}${current} · agent ${esc(member.agentId || 'unset')}</div>
        </div>
        <div class="actions">
          ${member.status === 'error' ? '<button data-action="retry">Retry</button>' : ''}
          <button data-action="stop">Stop</button>
          <button data-action="edit">Edit</button>
          <button data-action="copytool">Action URL</button>
        </div>
      </header>
      ${member.lastError ? `<div class="error-text">${esc(member.lastError)}</div>` : ''}
      <div class="messages">
        ${member.messages.map((message) => `
          <div class="msg ${esc(message.role)} ${message.pending ? 'pending-msg' : ''}">
            <div class="small">${esc(message.role)} · ${esc(message.at || '')}${message.pending ? ' · pending' : ''}</div>
            ${esc(message.content)}
          </div>
        `).join('')}
      </div>
      <div class="footer">
        <form data-action="direct">
          <input placeholder="Prompt only this chat" ${member.active ? '' : 'disabled'}>
          <button ${member.active ? '' : 'disabled'}>Send</button>
        </form>
      </div>
      <div class="member-editor${editorOpen}">
        <label>Name<input name="name" value="${esc(member.name)}"></label>
        <label>LibreChat Agent ID<input name="agentId" list="agentOptions" value="${esc(member.agentId)}"></label>
        <label>Agent / developer instructions<textarea name="developerPrompt">${esc(member.developerPrompt)}</textarea></label>
        <div class="check-row">
          <label><input type="checkbox" name="active" ${member.active ? 'checked' : ''}> active</label>
          <label><input type="checkbox" name="canInspectOthers" ${member.canInspectOthers ? 'checked' : ''}> inspect peers</label>
          <label><input type="checkbox" name="canSendOthers" ${member.canSendOthers ? 'checked' : ''}> queue to peers</label>
        </div>
        <div class="actions">
          <button data-action="save">Save</button>
          <button class="danger" data-action="delete">Delete</button>
        </div>
        <div class="small">LibreChat Action spec: ${esc(member.actionSpecUrl || '')}</div>
      </div>
    </article>
  `;
}

async function refresh() {
  if (!currentId) return;
  try {
    const workspace = await request(`/api/workspaces/${currentId}`);
    const members = Object.values(workspace.members);
    const agentOptions = agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}${agent.provider ? ` · ${esc(agent.provider)}` : ''}</option>`).join('');
    $('#app').innerHTML = `
      <datalist id="agentOptions">${agentOptions}</datalist>
      <div class="workspace-head">
        <div class="workspace-fields">
          <input id="wname" value="${esc(workspace.name)}">
          <label>Workspace system instructions<textarea id="globalPrompt" placeholder="Shared system prompt">${esc(workspace.globalPrompt)}</textarea></label>
          <div class="small">Instruction hierarchy: system → developer → user. Native mode requires the documented LibreChat patch; compat mode replays isolated local history.</div>
        </div>
        <div class="toolbar">
          <span class="status ${workspace.runtimeState.toLowerCase()}">${esc(workspace.runtimeState)}</span>
          <button id="saveWorkspace">Save</button>
          <button id="addMember">Add chat</button>
          <button id="stop" class="danger">Stop all</button>
        </div>
      </div>
      <div class="composer">
        <textarea id="broadcastPrompt" placeholder="One prompt → every active independent chat"></textarea>
        <button class="primary" id="broadcast">Broadcast</button>
      </div>
      ${members.length ? `<div class="members">${members.map((member) => memberCard(workspace, member)).join('')}</div>` : '<div class="empty-inline">Add at least one independent chat.</div>'}
      <div class="compile">
        <div class="compile-head">
          <strong>Optional response compression</strong>
          <div class="toolbar">
            <input id="compileAgentId" list="agentOptions" placeholder="Compiler Agent ID (blank = first active)" value="${esc(workspace.compileAgentId || '')}">
            <button id="compile" ${workspace.runtimeState === 'SETTLED' ? '' : 'disabled'}>Compile</button>
          </div>
        </div>
        <label>Compile instructions<textarea id="compilePrompt">${esc(workspace.compilePrompt || '')}</textarea></label>
        ${workspace.lastCompile ? `<hr><div class="small">${esc(workspace.lastCompile.at)}</div><div class="compile-output">${esc(workspace.lastCompile.text)}</div>` : '<div class="small">Manual only. Compile never feeds its result back into member histories.</div>'}
      </div>
    `;
    wire(workspace);
  } catch (error) {
    console.error(error);
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
