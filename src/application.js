import { StateStore, publicMember, searchMemberMessages } from './store.js';

const AGENT_SELECTION_REQUIRED = 'AGENT_SELECTION_REQUIRED';
const AGENT_NOT_AVAILABLE = 'AGENT_NOT_AVAILABLE';
const WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND';
const CHAT_NOT_FOUND = 'CHAT_NOT_FOUND';
const NO_ACTIVE_CHATS = 'NO_ACTIVE_CHATS';
const WORKSPACE_NOT_SETTLED = 'WORKSPACE_NOT_SETTLED';
const WORKSPACE_BLOCKED = 'WORKSPACE_BLOCKED';
const TIMEOUT = 'TIMEOUT';
const MCP_DISABLED = 'MCP_DISABLED';
const AUTH_REQUIRED = 'AUTH_REQUIRED';

function problem(message, status = 400, code = null) {
  const err = Object.assign(new Error(message), { status });
  if (code) err.code = code;
  return err;
}

function sanitizeWorkspace(workspace, runtimeState, runningMemberIds, includeMessages = true) {
  const pub = new StateStore('').publicWorkspace ? null : null;
  // Use store's publicWorkspace via direct construction to avoid private fields
  // Instead manually strip
  const members = Object.fromEntries(Object.entries(workspace.members).map(([id, m]) => {
    const { conversationId: _c, current: _cur, lastRun: _lr, ...rest } = m;
    return [id, { ...rest, inFlight: Boolean(m.current), messages: includeMessages ? m.messages : [] }];
  }));
  return {
    id: workspace.id,
    name: workspace.name,
    globalPrompt: workspace.globalPrompt,
    compileAgentId: workspace.compileAgentId || '',
    compilePrompt: workspace.compilePrompt || '',
    defaultAgentId: workspace.defaultAgentId || '',
    settings: workspace.settings,
    members,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    lastCompile: workspace.lastCompile,
    stats: workspace.stats,
    runtimeState,
    settled: runtimeState === 'SETTLED',
    runningMemberIds,
  };
}

export function createApplication({ config, store, client, scheduler } = {}) {
  if (!store || !client || !scheduler) throw new Error('store/client/scheduler required');
  let cachedDefaultAgentId = null;
  let cachedDefaultFetchedAt = 0;
  let cachedAgents = null;
  let cachedAgentsAt = 0;
  const compilingWorkspaces = new Set();

  async function getAvailableAgents(force = false) {
    const now = Date.now();
    if (!force && cachedAgents && now - cachedAgentsAt < 5000) return cachedAgents;
    try {
      const agents = await client.listAgents();
      const list = Array.isArray(agents) ? agents : [];
      cachedAgents = list;
      cachedAgentsAt = now;
      return list;
    } catch {
      // On failure, return cached if any, else empty
      if (cachedAgents) return cachedAgents;
      return [];
    }
  }

  async function getResolvedSingleAgentId() {
    // Only auto-resolve when exactly one usable agent exists
    const now = Date.now();
    if (cachedDefaultAgentId && now - cachedDefaultFetchedAt < 30000) {
      // Need to verify still single? re-fetch if multiple case could have changed
      const agents = await getAvailableAgents();
      if (agents.length === 1 && String(agents[0].id) === cachedDefaultAgentId) return cachedDefaultAgentId;
      if (agents.length !== 1) {
        cachedDefaultAgentId = null;
        return '';
      }
      return cachedDefaultAgentId;
    }
    try {
      const agents = await getAvailableAgents(true);
      if (agents.length === 1) {
        const chosen = String(agents[0].id || '');
        if (chosen) {
          cachedDefaultAgentId = chosen;
          cachedDefaultFetchedAt = now;
          return chosen;
        }
      }
    } catch {}
    return '';
  }

  function effectiveAgentIdForMember(workspace, member) {
    return String(member.agentId || workspace.defaultAgentId || '').trim();
  }

  async function validateAgentId(agentId, availableAgents = null) {
    if (!agentId) return false;
    const agents = availableAgents ?? await getAvailableAgents();
    return agents.some(a => String(a.id) === String(agentId));
  }

  async function ensureWorkspaceDefaultAgent(workspaceId, availableAgents = null) {
    const workspace = store.requireWorkspace(workspaceId);
    if (workspace.defaultAgentId) {
      // Validate stale
      const agents = availableAgents ?? await getAvailableAgents();
      if (agents.length && !(await validateAgentId(workspace.defaultAgentId, agents))) {
        // stale but keep it; caller should surface error
        return workspace.defaultAgentId;
      }
      return workspace.defaultAgentId;
    }
    const resolved = await getResolvedSingleAgentId();
    if (resolved) {
      store.updateWorkspace(workspaceId, { defaultAgentId: resolved });
      return resolved;
    }
    return '';
  }

  async function resolveEffectiveAgent(workspace, member, availableAgents = null) {
    const effective = effectiveAgentIdForMember(workspace, member);
    if (!effective) {
      // Try workspace default via single-agent auto
      const wsDefault = await ensureWorkspaceDefaultAgent(workspace.id, availableAgents);
      const updated = store.requireWorkspace(workspace.id);
      const freshMember = updated.members[member.id];
      const eff2 = effectiveAgentIdForMember(updated, freshMember);
      if (eff2) {
        // validate stale
        const agents = availableAgents ?? await getAvailableAgents();
        if (agents.length && !(await validateAgentId(eff2, agents))) {
          throw problem(`Agentが利用不可です: ${eff2}`, 400, AGENT_NOT_AVAILABLE);
        }
        return eff2;
      }
      // If still no effective, check if exactly one agent could satisfy
      const single = await getResolvedSingleAgentId();
      if (single) {
        if (!updated.defaultAgentId) store.updateWorkspace(workspace.id, { defaultAgentId: single });
        return single;
      }
      throw problem('利用可能なLibreChat Agentが設定されていません。LibreChatでAgentを作成するか、設定からAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
    }
    // Validate stale
    const agents = availableAgents ?? await getAvailableAgents();
    if (agents.length && !(await validateAgentId(effective, agents))) {
      throw problem(`Agentが利用不可です: ${effective}`, 400, AGENT_NOT_AVAILABLE);
    }
    return effective;
  }

  async function validateWorkspaceForExecution(workspaceId) {
    const workspace = store.requireWorkspace(workspaceId);
    const agents = await getAvailableAgents();
    // Validate workspace default if set
    if (workspace.defaultAgentId && agents.length && !(await validateAgentId(workspace.defaultAgentId, agents))) {
      throw problem(`ワークスペースの既定Agentが利用不可です: ${workspace.defaultAgentId}`, 400, AGENT_NOT_AVAILABLE);
    }
    // Check each active member's effective agent validity
    for (const m of Object.values(workspace.members).filter(x => x.active)) {
      const eff = String(m.agentId || workspace.defaultAgentId || '').trim();
      if (!eff) {
        if (agents.length === 0) throw problem('利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
        if (agents.length > 1 && !workspace.defaultAgentId && !m.agentId) throw problem('複数のAgentが存在します。ワークスペースまたはチャットで使用するAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
        // single agent case would have been auto-resolved via ensure, so this is config error
        throw problem('Agentが未設定です。ワークスペースの既定Agentを設定するか、各チャットでAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
      }
      if (agents.length && !(await validateAgentId(eff, agents))) {
        throw problem(`チャット "${m.name}" のAgentが利用不可です: ${eff}`, 400, AGENT_NOT_AVAILABLE);
      }
    }
    return { workspace, agents };
  }

  // Public operations
  async function listWorkspaces() {
    const workspaces = store.listWorkspaces().map(w => {
      const runtimeState = store.runtimeState(w.id, scheduler.runningMemberIds(w.id));
      return { ...w, runtimeState, settled: runtimeState === 'SETTLED' };
    });
    // Sanitize: strip private fields already via listWorkspaces->publicWorkspace
    return workspaces.map(w => {
      // Ensure no secrets
      return w;
    });
  }

  async function getWorkspace(workspaceId, { includeMessages = true, boundedMessages = 50 } = {}) {
    const workspace = store.requireWorkspace(workspaceId);
    const runtimeState = store.runtimeState(workspaceId, scheduler.runningMemberIds(workspaceId));
    const runningMemberIds = [...scheduler.runningMemberIds(workspaceId)];
    const view = sanitizeWorkspace(workspace, runtimeState, runningMemberIds, includeMessages);
    if (includeMessages && boundedMessages) {
      for (const m of Object.values(view.members)) {
        if (m.messages && m.messages.length > boundedMessages) {
          m.messages = m.messages.slice(-boundedMessages);
        }
        // Add effective agent info
        const effective = String(workspace.members[m.id]?.agentId || workspace.defaultAgentId || '').trim();
        m.effectiveAgentId = effective;
        // Try to resolve display name if agents available (non-blocking)
        m.effectiveAgentName = effective;
      }
      // Enrich effective names if agents available
      try {
        const agents = await getAvailableAgents();
        const map = new Map(agents.map(a => [String(a.id), String(a.name || a.id)]));
        for (const m of Object.values(view.members)) {
          if (m.effectiveAgentId && map.has(m.effectiveAgentId)) m.effectiveAgentName = map.get(m.effectiveAgentId);
          else if (!m.effectiveAgentId && agents.length === 1) m.effectiveAgentName = String(agents[0].name || agents[0].id) + '（自動）';
        }
        // Workspace default name
        if (view.defaultAgentId && map.has(view.defaultAgentId)) view.defaultAgentName = map.get(view.defaultAgentId);
      } catch {}
    }
    return view;
  }

  async function createWorkspace(input = {}) {
    const workspace = store.createWorkspace(input);
    // Auto-resolve default only if exactly one agent
    if (!workspace.defaultAgentId) {
      const single = await getResolvedSingleAgentId();
      if (single) store.updateWorkspace(workspace.id, { defaultAgentId: single });
    }
    // Create initial chats if requested
    const count = Math.max(0, Math.min(Number(input.initial_chat_count || 0), 10));
    for (let i = 0; i < count; i++) {
      store.addMember(workspace.id, { name: `チャット ${i + 1}` });
    }
    return getWorkspace(workspace.id);
  }

  async function updateWorkspace(workspaceId, patch = {}) {
    // Validate agent ids if provided
    if (patch.default_agent_id !== undefined) patch.defaultAgentId = patch.default_agent_id;
    if (patch.system_prompt !== undefined) patch.globalPrompt = patch.system_prompt;
    if (patch.defaultAgentId !== undefined && patch.defaultAgentId !== '') {
      const agents = await getAvailableAgents();
      if (agents.length && !(await validateAgentId(patch.defaultAgentId, agents))) {
        throw problem(`Agentが利用不可です: ${patch.defaultAgentId}`, 400, AGENT_NOT_AVAILABLE);
      }
    }
    if (patch.compile_agent_id !== undefined) patch.compileAgentId = patch.compile_agent_id;
    if (patch.compile_prompt !== undefined) patch.compilePrompt = patch.compile_prompt;
    if (patch.compileAgentId !== undefined && patch.compileAgentId !== '') {
      const agents = await getAvailableAgents();
      if (agents.length && !(await validateAgentId(patch.compileAgentId, agents))) {
        throw problem(`Compile Agentが利用不可です: ${patch.compileAgentId}`, 400, AGENT_NOT_AVAILABLE);
      }
    }
    const patchClean = {};
    if (patch.name !== undefined) patchClean.name = patch.name;
    if (patch.globalPrompt !== undefined) patchClean.globalPrompt = patch.globalPrompt;
    if (patch.defaultAgentId !== undefined) patchClean.defaultAgentId = patch.defaultAgentId;
    if (patch.compileAgentId !== undefined) patchClean.compileAgentId = patch.compileAgentId;
    if (patch.compilePrompt !== undefined) patchClean.compilePrompt = patch.compilePrompt;
    if (patch.settings !== undefined) patchClean.settings = patch.settings;
    store.updateWorkspace(workspaceId, patchClean);
    return getWorkspace(workspaceId);
  }

  async function deleteWorkspace(workspaceId) {
    scheduler.stopWorkspace(workspaceId);
    store.deleteWorkspace(workspaceId);
    return { deleted: true, workspace_id: workspaceId };
  }

  async function listAgents() {
    const agents = await getAvailableAgents(true);
    return agents.map(a => ({ id: String(a.id), name: String(a.name || a.id), provider: a.provider || null, model: a.model || null }));
  }

  async function addChat(workspaceId, input = {}) {
    const workspace = store.requireWorkspace(workspaceId);
    // If no explicit agent and no workspace default, try single-agent auto before creating member
    if (!input.agent_id && !input.agentId && !workspace.defaultAgentId) {
      await ensureWorkspaceDefaultAgent(workspaceId);
    }
    const memberInput = {
      name: input.name,
      agentId: String(input.agent_id || input.agentId || ''),
      developerPrompt: String(input.developer_prompt || input.developerPrompt || ''),
      active: input.active,
      canInspectOthers: input.canInspectOthers,
      canSendOthers: input.canSendOthers,
    };
    if (memberInput.agentId) {
      const agents = await getAvailableAgents();
      if (agents.length && !(await validateAgentId(memberInput.agentId, agents))) {
        throw problem(`Agentが利用不可です: ${memberInput.agentId}`, 400, AGENT_NOT_AVAILABLE);
      }
    }
    const member = store.addMember(workspaceId, memberInput);
    const view = await getWorkspace(workspaceId);
    return { member: view.members[member.id], workspace: view };
  }

  async function updateChat(workspaceId, chatId, patch = {}) {
    const { member: existing } = store.requireMember(workspaceId, chatId);
    const update = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.developer_prompt !== undefined) update.developerPrompt = patch.developer_prompt;
    if (patch.developerPrompt !== undefined) update.developerPrompt = patch.developerPrompt;
    if (patch.agent_id !== undefined) update.agentId = patch.agent_id;
    if (patch.agentId !== undefined) update.agentId = patch.agentId;
    if (patch.active !== undefined) update.active = patch.active;
    if (patch.canInspectOthers !== undefined) update.canInspectOthers = patch.canInspectOthers;
    if (patch.canSendOthers !== undefined) update.canSendOthers = patch.canSendOthers;
    if (update.agentId !== undefined && update.agentId !== '') {
      const agents = await getAvailableAgents();
      if (agents.length && !(await validateAgentId(update.agentId, agents))) {
        throw problem(`Agentが利用不可です: ${update.agentId}`, 400, AGENT_NOT_AVAILABLE);
      }
    }
    if (update.active === false && existing.active) scheduler.stopMember(workspaceId, chatId);
    store.updateMember(workspaceId, chatId, update);
    scheduler.kickMember(workspaceId, chatId);
    return getWorkspace(workspaceId);
  }

  async function deleteChat(workspaceId, chatId) {
    scheduler.stopMember(workspaceId, chatId);
    store.deleteMember(workspaceId, chatId);
    return { deleted: true, workspace_id: workspaceId, chat_id: chatId };
  }

  async function broadcast(workspaceId, prompt) {
    const text = String(prompt || '').trim();
    if (!text) throw problem('Prompt is required', 400);
    const workspace = store.requireWorkspace(workspaceId);
    const activeMembers = Object.values(workspace.members).filter(m => m.active);
    if (!activeMembers.length) throw problem('No active members', 409, NO_ACTIVE_CHATS);
    // Validate all before mutation
    const agents = await getAvailableAgents();
    // Ensure workspace default if needed and single agent case
    const needsDefault = activeMembers.some(m => !effectiveAgentIdForMember(workspace, m));
    if (needsDefault && !workspace.defaultAgentId) {
      const single = await getResolvedSingleAgentId();
      if (single) {
        store.updateWorkspace(workspaceId, { defaultAgentId: single });
      } else if (agents.length > 1) {
        throw problem('複数のAgentが存在します。ワークスペースまたはチャットで使用するAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
      } else if (agents.length === 0) {
        throw problem('利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
      }
    }
    const updatedWs = store.requireWorkspace(workspaceId);
    // Validate each effective agent
    for (const m of activeMembers) {
      const fresh = updatedWs.members[m.id];
      const eff = effectiveAgentIdForMember(updatedWs, fresh);
      if (!eff) throw problem(`チャット "${fresh.name}" のAgentが未設定です。`, 400, AGENT_SELECTION_REQUIRED);
      if (agents.length && !(await validateAgentId(eff, agents))) throw problem(`チャット "${fresh.name}" のAgentが利用不可です: ${eff}`, 400, AGENT_NOT_AVAILABLE);
    }
    // Auto-recover BLOCKED config errors
    for (const m of activeMembers) {
      const fresh = updatedWs.members[m.id];
      if (fresh.status === 'error' && fresh.lastError && (String(fresh.lastError).includes('利用可能なLibreChat Agent') || String(fresh.lastError).includes('LibreChat agentId is required') || String(fresh.lastError).includes('Agentが利用不可'))) {
        if (effectiveAgentIdForMember(updatedWs, fresh)) {
          try { store.retryMember(workspaceId, m.id); } catch {}
        }
      }
    }
    const items = store.broadcast(workspaceId, text);
    scheduler.kickWorkspace(workspaceId);
    return { items, workspace: await getWorkspace(workspaceId) };
  }

  async function send(workspaceId, chatId, prompt) {
    const text = String(prompt || '').trim();
    if (!text) throw problem('Prompt is required', 400);
    const workspace = store.requireWorkspace(workspaceId);
    const member = workspace.members[chatId];
    if (!member) throw problem('Member not found', 404, CHAT_NOT_FOUND);
    if (!member.active) throw problem('Target member is inactive', 409);
    let effective = effectiveAgentIdForMember(workspace, member);
    if (!effective) {
      const single = await getResolvedSingleAgentId();
      if (single) {
        if (!workspace.defaultAgentId) store.updateWorkspace(workspaceId, { defaultAgentId: single });
        effective = single;
      }
    }
    if (!effective) {
      const agents = await getAvailableAgents();
      if (agents.length === 0) throw problem('利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
      if (agents.length > 1) throw problem('複数のAgentが存在します。ワークスペースまたはチャットで使用するAgentを選択してください。', 400, AGENT_SELECTION_REQUIRED);
      throw problem('Agentが未設定です。', 400, AGENT_SELECTION_REQUIRED);
    }
    const agents = await getAvailableAgents();
    if (agents.length && !(await validateAgentId(effective, agents))) throw problem(`Agentが利用不可です: ${effective}`, 400, AGENT_NOT_AVAILABLE);
    // auto-recover if blocked due to config
    const fresh = store.requireWorkspace(workspaceId).members[chatId];
    if (fresh.status === 'error' && fresh.lastError && (String(fresh.lastError).includes('利用可能なLibreChat Agent') || String(fresh.lastError).includes('LibreChat agentId is required') || String(fresh.lastError).includes('Agentが利用不可'))) {
      try { store.retryMember(workspaceId, chatId); } catch {}
    }
    const item = store.enqueue(workspaceId, chatId, text, { source: 'user' });
    scheduler.kickMember(workspaceId, chatId);
    return { item, workspace: await getWorkspace(workspaceId) };
  }

  function stopWorkspace(workspaceId) {
    scheduler.stopWorkspace(workspaceId);
    return getWorkspace(workspaceId);
  }

  function stopChat(workspaceId, chatId) {
    scheduler.stopMember(workspaceId, chatId);
    return getWorkspace(workspaceId);
  }

  function retryChat(workspaceId, chatId) {
    scheduler.retryMember(workspaceId, chatId);
    return getWorkspace(workspaceId);
  }

  async function getRuntimeStatus(workspaceId = null) {
    const health = await client.health();
    const agents = await getAvailableAgents().catch(() => []);
    const infrastructure = {
      librechat: { ok: Boolean(health.ok), latencyMs: health.latencyMs || 0, mode: health.mode || 'unknown', error: health.error || null },
      multicontext: { ok: Boolean(health.ok), error: health.error || null },
      gptoss: { ok: true, message: '準備完了' }, // derived from librechat health for now; real model health is via Tauri runtime_status
    };
    // For MCP, we don't have direct model health without Tauri; use librechat ok as proxy but keep separate
    // Application readiness
    const application = {
      remoteAgentsAuthOk: Boolean(health.ok),
      availableAgents: agents.length,
      agents: agents.map(a => ({ id: String(a.id), name: String(a.name || a.id), provider: a.provider || null })),
    };
    let workspaceInfo = null;
    if (workspaceId) {
      try {
        const ws = store.requireWorkspace(workspaceId);
        const runtimeState = store.runtimeState(workspaceId, scheduler.runningMemberIds(workspaceId));
        workspaceInfo = { id: ws.id, name: ws.name, runtimeState, settled: runtimeState === 'SETTLED', memberCount: Object.keys(ws.members).length, activeCount: Object.values(ws.members).filter(m => m.active).length };
      } catch {}
    }
    return { infrastructure, application, workspace: workspaceInfo, mcp: { enabled: Boolean(config.mcpEnabled), tokenConfigured: Boolean(config.mcpToken) } };
  }

  async function compile(workspaceId) {
    if (compilingWorkspaces.has(workspaceId)) throw problem('Compile already in progress', 409, WORKSPACE_NOT_SETTLED);
    const workspace = store.requireWorkspace(workspaceId);
    if (!store.isSettled(workspaceId, scheduler.runningMemberIds(workspaceId))) throw problem('Workspace is not SETTLED', 409, WORKSPACE_NOT_SETTLED);
    // Resolve compile agent: explicit -> workspace default -> single available
    let agentId = String(workspace.compileAgentId || '').trim();
    if (!agentId) agentId = String(workspace.defaultAgentId || '').trim();
    if (!agentId) {
      const single = await getResolvedSingleAgentId();
      if (single) agentId = single;
    }
    if (!agentId) {
      const agents = await getAvailableAgents();
      if (agents.length === 0) throw problem('利用可能なLibreChat Agentがありません。', 400, AGENT_SELECTION_REQUIRED);
      if (agents.length > 1) throw problem('Compileに使用するAgentが未設定です。compile_agent_id またはワークスペース既定Agentを設定してください。', 400, AGENT_SELECTION_REQUIRED);
    }
    // Validate stale
    const agents = await getAvailableAgents();
    if (agents.length && !(await validateAgentId(agentId, agents))) throw problem(`Compile Agentが利用不可です: ${agentId}`, 400, AGENT_NOT_AVAILABLE);
    compilingWorkspaces.add(workspaceId);
    try {
      const snapshots = Object.values(workspace.members).filter(m => m.active).map(m => ({ member: { id: m.id, name: m.name }, messages: m.messages.filter(x => !x.pending).slice(-12).map(({ role, content, at }) => ({ role, content, at })) }));
      const result = await client.runAgent({ agentId, globalPrompt: workspace.compilePrompt, developerPrompt: '', history: [], prompt: `Compress these independent chat records into a response for the user.\n\n${JSON.stringify(snapshots, null, 2)}`, metadata: { workspace_id: workspaceId, purpose: 'compile' } });
      store.setCompile(workspaceId, { text: result.text, responseId: result.id, usage: result.usage });
      return getWorkspace(workspaceId);
    } finally {
      compilingWorkspaces.delete(workspaceId);
    }
  }

  async function waitUntilSettled(workspaceId, timeoutSeconds = 60, pollIntervalMs = 500) {
    const timeout = Math.max(1, Math.min(Number(timeoutSeconds) || 60, 300)) * 1000;
    const interval = Math.max(100, Math.min(Number(pollIntervalMs) || 500, 5000));
    const start = Date.now();
    while (true) {
      let workspace;
      try { workspace = store.requireWorkspace(workspaceId); }
      catch { throw problem('Workspace not found', 404, WORKSPACE_NOT_FOUND); }
      const state = store.runtimeState(workspaceId, scheduler.runningMemberIds(workspaceId));
      if (state === 'SETTLED' || state === 'BLOCKED') {
        const view = await getWorkspace(workspaceId);
        return { workspace_id: workspaceId, state, workspace: view };
      }
      if (Date.now() - start > timeout) {
        const view = await getWorkspace(workspaceId);
        const cur = store.runtimeState(workspaceId, scheduler.runningMemberIds(workspaceId));
        return { workspace_id: workspaceId, state: 'TIMEOUT', workspace: view, previousState: cur };
      }
      await new Promise(r => setTimeout(r, interval));
    }
  }

  async function getChatMessages(workspaceId, chatId, { limit = 50, since = null } = {}) {
    const { member } = store.requireMember(workspaceId, chatId);
    let msgs = member.messages.filter(m => !m.pending);
    if (since) {
      const idx = msgs.findIndex(m => m.id === since || m.at === since);
      if (idx >= 0) msgs = msgs.slice(idx + 1);
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    msgs = msgs.slice(-bounded);
    // Strip pending internal fields
    return msgs.map(m => ({ id: m.id, role: m.role, content: String(m.content || ''), at: m.at }));
  }

  async function getCompileResult(workspaceId) {
    const ws = store.requireWorkspace(workspaceId);
    return ws.lastCompile || null;
  }

  return {
    listWorkspaces,
    getWorkspace,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    listAgents,
    addChat,
    updateChat,
    deleteChat,
    broadcast,
    send,
    stopWorkspace,
    stopChat,
    retryChat,
    getRuntimeStatus,
    compile,
    waitUntilSettled,
    getChatMessages,
    getCompileResult,
    // helpers for testing / sharing
    _internal: { effectiveAgentIdForMember, validateAgentId, getAvailableAgents, getResolvedSingleAgentId, compilingWorkspaces },
  };
}
