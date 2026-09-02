import * as z from 'zod';

// In-memory Q fallback for tests without store
const QStore = new Map();
let qCounter = 0;

export function getQ(workspaceId) {
  if (!QStore.has(workspaceId)) QStore.set(workspaceId, []);
  return QStore.get(workspaceId);
}

export function pushQ(workspaceId, prompt, priority = 1) {
  const q = getQ(workspaceId);
  const item = { id: `q-${++qCounter}`, prompt: String(prompt), priority: Number(priority), createdAt: new Date().toISOString() };
  q.push(item);
  q.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  return item;
}

export function popQ(workspaceId) {
  const q = getQ(workspaceId);
  return q.shift() || null;
}

export function peekQ(workspaceId, limit = 10) {
  return getQ(workspaceId).slice(0, limit);
}

export const PRESETS = {
  'navier-stokes-4': {
    name: 'Navier-Stokes Demo',
    members: [
      { name: 'A — PDE Analyst', developerPrompt: 'You are the PDE / functional-analysis specialist. Use the marker [PDE_A] naturally in your first substantive response. Focus on energy estimates, Sobolev regularity, weak/strong solutions, and a priori estimates.' },
      { name: 'B — Fluid Dynamics', developerPrompt: 'You are the fluid-dynamics / vorticity specialist. Use the marker [VORTEX_B] naturally in your first substantive response. Focus on vorticity, vortex stretching, physical interpretation, and 2D versus 3D behavior.' },
      { name: 'C — Scaling Analyst', developerPrompt: 'You are the scaling / critical-spaces specialist. Use the marker [SCALE_C] naturally in your first substantive response. Focus on Navier-Stokes scaling, critical norms, blow-up criteria, and regularity conditions.' },
      { name: 'D — Reviewer', developerPrompt: 'You are a skeptical mathematical reviewer. Use the marker [REVIEW_D] naturally in your first substantive response. Look for unjustified claims, distinguish theorem from heuristic, and challenge the other analyses.' },
    ],
    seedPrompt: `Consider the 3D incompressible Navier-Stokes equations

∂u/∂t + (u·∇)u = -∇p + νΔu + f
∇·u = 0.

Analyze why global regularity in 3D remains difficult.

Start by reasoning independently from your own context.

Discuss:
1. the nonlinear transport term,
2. the energy estimate,
3. vorticity and vortex stretching,
4. the essential 2D/3D difference,
5. scaling and critical quantities,
6. what kind of a priori estimate would be needed to rule out finite-time blow-up.

After your independent analysis, identify at least one point that should be checked by another specialist.

Use list_chats, inspect_chat, or send_to_chat when doing so would improve the analysis.

Do not claim to solve the Navier-Stokes Millennium problem.
Clearly distinguish known results, heuristic reasoning, and unresolved questions.`,
  },
};

const terminalRunStatuses = new Set(['settled', 'blocked', 'failed', 'cancelled']);
const targetFromArgs = ({ broadcast, chat_id }) => broadcast ? { type: 'broadcast' } : chat_id ? { type: 'member', memberId: chat_id } : { type: 'broadcast' };

export function registerOrchestratorTools(server, app, store) {
  const hasStore = store && typeof store.createOrchestratorRun === 'function';
  const scheduler = app?._scheduler || null;

  const createRunRecord = ({ workspaceId, prompt, priority = 1, target }) => {
    const run = store.createOrchestratorRun(workspaceId, { prompt, priority, origin: 'mcp', actor: 'orchestrator' });
    const qItem = store.enqueueOrchestrator(workspaceId, prompt, { priority, origin: 'mcp', actor: 'orchestrator', runId: run.id, target });
    return { run, qItem };
  };

  const dispatchRun = async ({ workspaceId, run, qItem, timeoutSeconds = 300 }) => {
    const currentRun = store.getOrchestratorRun(workspaceId, run.id);
    if (terminalRunStatuses.has(currentRun.status)) return { run: currentRun, qItem, enqueueResult: null, wait: null };
    if (currentRun.status === 'queued') store.updateOrchestratorRun(workspaceId, run.id, { status: 'running' });
    const currentQ = store.getWorkspace(workspaceId).orchestratorQueue.find(q => q.id === qItem.id);
    if (currentQ?.state === 'pending' || currentQ?.state === 'claimed') {
      store.updateOrchestratorQueueItem(workspaceId, qItem.id, { state: 'dispatched' });
    }

    let enqueueResult;
    try {
      const target = qItem.target || { type: 'broadcast' };
      const provenance = { orchestratorRunId: run.id, orchestratorQId: qItem.id };
      if (target.type === 'member') enqueueResult = await app.send(workspaceId, target.memberId, qItem.prompt, provenance);
      else enqueueResult = await app.broadcast(workspaceId, qItem.prompt, provenance);

      const wait = await app.waitUntilSettled(workspaceId, timeoutSeconds, 500);
      const latest = store.getOrchestratorRun(workspaceId, run.id);
      if (terminalRunStatuses.has(latest.status) && latest.status !== 'running') return { run: latest, qItem, enqueueResult, wait };

      const finalStatus = wait.state === 'SETTLED' ? 'settled' : wait.state === 'BLOCKED' ? 'blocked' : 'failed';
      store.updateOrchestratorRun(workspaceId, run.id, { status: finalStatus });
      store.markDispatchedQDone(workspaceId, run.id, finalStatus);
      return { run: store.getOrchestratorRun(workspaceId, run.id), qItem, enqueueResult, wait };
    } catch (error) {
      const latest = store.getOrchestratorRun(workspaceId, run.id);
      if (!terminalRunStatuses.has(latest.status)) {
        try { store.updateOrchestratorRun(workspaceId, run.id, { status: 'failed', error: String(error.message || error) }); } catch {}
        try {
          const q = store.getWorkspace(workspaceId).orchestratorQueue.find(x => x.id === qItem.id);
          if (q && (q.state === 'pending' || q.state === 'claimed' || q.state === 'dispatched')) {
            if (q.state === 'pending') store.updateOrchestratorQueueItem(workspaceId, q.id, { state: 'dispatched' });
            store.updateOrchestratorQueueItem(workspaceId, q.id, { state: 'failed' });
          }
        } catch {}
      }
      throw error;
    }
  };

  const startRun = ({ workspaceId, prompt, priority = 1, target, timeoutSeconds = 300, detached = true }) => {
    const { run, qItem } = createRunRecord({ workspaceId, prompt, priority, target });
    const paused = Boolean(store.getWorkspace(workspaceId).orchestratorPaused);
    if (paused) return { run, qItem, paused: true, execution: null };
    const execution = dispatchRun({ workspaceId, run, qItem, timeoutSeconds });
    if (detached) void execution.catch(() => {});
    return { run, qItem, paused: false, execution };
  };

  const resumeQueuedRun = (workspaceId) => {
    if (store.getWorkspace(workspaceId).orchestratorPaused) return null;
    const run = store.listOrchestratorRuns(workspaceId).filter(r => r.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!run) return null;
    const qItem = store.getWorkspace(workspaceId).orchestratorQueue.find(q => q.runId === run.id && q.state === 'pending');
    if (!qItem) return null;
    const execution = dispatchRun({ workspaceId, run, qItem, timeoutSeconds: 300 });
    void execution.catch(() => {});
    return { run, qItem };
  };

  const cancelRun = (workspaceId, runId) => {
    const run = store.getOrchestratorRun(workspaceId, runId);
    if (run.status !== 'running' && run.status !== 'queued') return { run, aborted: 0, cancelledMemberItems: 0 };
    const aborted = typeof scheduler?.abortByOrchestratorRun === 'function' ? scheduler.abortByOrchestratorRun(workspaceId, runId) : 0;
    const cancelledMemberItems = store.cancelOrchestratorRunMembers(workspaceId, runId);
    store.updateOrchestratorRun(workspaceId, runId, { status: 'cancelled' });
    return { run: store.getOrchestratorRun(workspaceId, runId), aborted, cancelledMemberItems };
  };

  server.registerTool('multicontext_orchestrate_create_session', {
    description: 'Create a workspace with preset personas and seed Q with initial tasks. Returns workspace and member ids. This is the entry point for orchestrated multi-agent sessions.',
    inputSchema: z.object({ preset: z.enum(['navier-stokes-4']).optional(), name: z.string().optional(), globalPrompt: z.string().optional() }),
  }, async ({ preset, name, globalPrompt }) => {
    const p = PRESETS[preset || 'navier-stokes-4'];
    const ws = await app.createWorkspace({ name: name || p.name, globalPrompt: globalPrompt || '' });
    const members = [];
    for (const m of p.members) {
      const r = await app.addChat(ws.id, { name: m.name, developerPrompt: m.developerPrompt });
      members.push(r.member);
    }
    if (hasStore) {
      store.enqueueOrchestrator(ws.id, p.seedPrompt, { priority: 0, origin: 'mcp', actor: 'orchestrator', target: { type: 'broadcast' } });
      store.appendEvent(ws.id, { type: 'mcp.session.created', origin: 'mcp', detail: { preset } });
    } else pushQ(ws.id, p.seedPrompt, 0);
    const view = await app.getWorkspace(ws.id);
    const q = hasStore ? store.peekOrchestratorQueue(ws.id) : peekQ(ws.id);
    return { content: [{ type: 'text', text: JSON.stringify({ workspace: view, members, q }, null, 2) }], structuredContent: { workspace: view, members, q } };
  });

  server.registerTool('multicontext_orchestrate_enqueue', {
    description: 'Enqueue a prompt to Q with priority (0=highest, 1=normal, 2=background). Pure Q operation: it remains pending for explicit claim/inspection and is not auto-dispatched. Use start_run to execute a prompt.',
    inputSchema: z.object({ workspace_id: z.string().min(1), prompt: z.string().min(1), priority: z.number().int().min(0).max(2).optional(), broadcast: z.boolean().optional(), chat_id: z.string().optional() }),
  }, async ({ workspace_id, prompt, priority, broadcast, chat_id }) => {
    const pr = priority ?? 1;
    const target = broadcast ? { type: 'broadcast' } : chat_id ? { type: 'member', memberId: chat_id } : null;
    const qItem = hasStore ? store.enqueueOrchestrator(workspace_id, prompt, { priority: pr, origin: 'mcp', actor: 'orchestrator', target }) : pushQ(workspace_id, prompt, pr);
    const q = hasStore ? store.peekOrchestratorQueue(workspace_id) : peekQ(workspace_id);
    return { content: [{ type: 'text', text: JSON.stringify({ qItem, queued: true, hint: 'Use start_run to execute a prompt' }, null, 2) }], structuredContent: { qItem, queued: true, q } };
  });

  server.registerTool('multicontext_orchestrate_next', {
    description: 'Pop the next Q item (highest priority) and optionally claim it. Use to let a sub-agent claim the next task.',
    inputSchema: z.object({ workspace_id: z.string().min(1), pop: z.boolean().optional() }),
  }, async ({ workspace_id, pop }) => {
    if (hasStore) {
      const item = store.peekOrchestratorQueue(workspace_id, 1)[0] || null;
      if (pop && item) store.updateOrchestratorQueueItem(workspace_id, item.id, { state: 'claimed' });
      const q = store.peekOrchestratorQueue(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify({ item, q }, null, 2) }], structuredContent: { item, q } };
    }
    const item = pop ? popQ(workspace_id) : peekQ(workspace_id, 1)[0] || null;
    return { content: [{ type: 'text', text: JSON.stringify({ item, q: peekQ(workspace_id) }, null, 2) }], structuredContent: { item, q: peekQ(workspace_id) } };
  });

  server.registerTool('multicontext_orchestrate_distill_context', {
    description: 'Distill a chat or workspace context into a token-bounded summary for handoff to a sub-agent. Uses bounded history without an extra LLM call.',
    inputSchema: z.object({ workspace_id: z.string().min(1), chat_id: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  }, async ({ workspace_id, chat_id, limit }) => {
    const lim = limit ?? 12;
    if (chat_id) {
      const msgs = await app.getChatMessages(workspace_id, chat_id, { limit: lim });
      const distilled = msgs.map(m => `${m.role}: ${m.content.slice(0,400)}`).join('\n---\n');
      return { content: [{ type: 'text', text: distilled }], structuredContent: { messages: msgs, distilled } };
    }
    const ws = await app.getWorkspace(workspace_id, { includeMessages: true, boundedMessages: lim });
    const all = Object.values(ws.members).map(m => `## ${m.name} (${m.id})\n${(m.messages || []).slice(-lim).map(x => `${x.role}: ${String(x.content).slice(0,300)}`).join('\n')}`).join('\n\n');
    return { content: [{ type: 'text', text: all.slice(0,8000) }], structuredContent: { workspace: ws, distilled: all.slice(0,8000) } };
  });

  server.registerTool('multicontext_orchestrate_extract_findings', {
    description: 'Return a structured snapshot of member findings, compile output, stats, queue, and recent events.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }),
  }, async ({ workspace_id }) => {
    const ws = await app.getWorkspace(workspace_id, { includeMessages: true, boundedMessages: 20 });
    const findings = {
      workspace: { id: ws.id, name: ws.name, runtimeState: ws.runtimeState },
      members: Object.values(ws.members).map(m => ({ id: m.id, name: m.name, lastMessage: (m.messages || []).slice(-1)[0]?.content?.slice(0,500) || null, messageCount: m.messages?.length || 0, status: m.status })),
      compile: ws.lastCompile,
      stats: ws.stats,
      q: hasStore ? store.peekOrchestratorQueue(workspace_id) : peekQ(workspace_id),
      events: hasStore ? store.listOrchestratorEvents(workspace_id, 10) : [],
    };
    return { content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }], structuredContent: findings };
  });

  server.registerTool('multicontext_orchestrate_join_as_member', {
    description: 'Join an existing workspace as a new sub-agent member with a custom developer prompt.',
    inputSchema: z.object({ workspace_id: z.string().min(1), name: z.string().min(1).max(100), developer_prompt: z.string().optional(), agent_id: z.string().optional() }),
  }, async ({ workspace_id, name, developer_prompt, agent_id }) => {
    const r = await app.addChat(workspace_id, { name, developerPrompt: developer_prompt || '', agentId: agent_id || '' });
    if (hasStore) store.appendEvent(workspace_id, { type: 'mcp.member.joined', origin: 'mcp', memberId: r.member.id, detail: { name } });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r };
  });

  server.registerTool('multicontext_orchestrate_run', {
    description: 'Synchronous compatibility wrapper around the same run engine as start_run. Prefer start_run for long operations.',
    inputSchema: z.object({ workspace_id: z.string().optional(), preset: z.enum(['navier-stokes-4']).optional(), name: z.string().optional(), prompt: z.string().min(1), priority: z.number().int().min(0).max(2).optional(), broadcast: z.boolean().optional(), chat_id: z.string().optional(), timeout_seconds: z.number().min(5).max(300).optional() }),
  }, async (args) => {
    let wsId = args.workspace_id;
    if (!wsId) {
      const p = PRESETS[args.preset || 'navier-stokes-4'];
      const ws = await app.createWorkspace({ name: args.name || p.name });
      for (const m of p.members) await app.addChat(ws.id, { name: m.name, developerPrompt: m.developerPrompt });
      wsId = ws.id;
    }
    if (!hasStore) {
      const enqueueResult = args.chat_id ? await app.send(wsId, args.chat_id, args.prompt) : await app.broadcast(wsId, args.prompt);
      const wait = await app.waitUntilSettled(wsId, args.timeout_seconds ?? 120, 500);
      return { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wsId, enqueueResult, wait }, null, 2) }], structuredContent: { workspace_id: wsId, enqueueResult, wait } };
    }
    const started = startRun({ workspaceId: wsId, prompt: args.prompt, priority: args.priority ?? 1, target: targetFromArgs(args), timeoutSeconds: args.timeout_seconds ?? 120, detached: false });
    if (started.paused) {
      const body = { workspace_id: wsId, run_id: started.run.id, queued: true, paused: true, qItem: started.qItem };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    }
    const completed = await started.execution;
    const q = store.peekOrchestratorQueue(wsId);
    const body = { workspace_id: wsId, run_id: started.run.id, enqueueResult: completed.enqueueResult, wait: completed.wait, q };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
  });

  server.registerTool('multicontext_orchestrate_start_run', {
    description: 'Start an async orchestrator run (non-blocking). Returns run_id immediately. Poll with multicontext_orchestrate_get_run.',
    inputSchema: z.object({ workspace_id: z.string().min(1), prompt: z.string().min(1), priority: z.number().int().min(0).max(2).optional(), broadcast: z.boolean().optional(), chat_id: z.string().optional() }),
  }, async ({ workspace_id, prompt, priority, broadcast, chat_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    let started;
    try {
      started = startRun({ workspaceId: workspace_id, prompt, priority: priority ?? 1, target: targetFromArgs({ broadcast, chat_id }), detached: true });
    } catch (error) {
      if (error.code === 'ORCHESTRATOR_RUN_ALREADY_ACTIVE') throw Object.assign(new Error('An orchestrator run is already active for this workspace'), { status: 409, code: error.code });
      throw error;
    }
    const body = { run_id: started.run.id, workspace_id, qItem: started.qItem, paused: started.paused, run: started.run };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
  });

  server.registerTool('multicontext_orchestrate_get_run', {
    description: 'Get orchestrator run status by run_id. Poll this after start_run.',
    inputSchema: z.object({ workspace_id: z.string().min(1), run_id: z.string().min(1) }),
  }, async ({ workspace_id, run_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const run = store.getOrchestratorRun(workspace_id, run_id);
    const q = store.peekOrchestratorQueue(workspace_id);
    const events = store.listOrchestratorEvents(workspace_id, 5);
    return { content: [{ type: 'text', text: JSON.stringify({ run, q, events }, null, 2) }], structuredContent: { run, q, events } };
  });

  server.registerTool('multicontext_orchestrate_cancel_run', {
    description: 'Cancel a run, abort only its in-flight model requests, and remove only its member/Q work. Unrelated human/cross-chat work is preserved.',
    inputSchema: z.object({ workspace_id: z.string().min(1), run_id: z.string().min(1) }),
  }, async ({ workspace_id, run_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const result = cancelRun(workspace_id, run_id);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool('multicontext_orchestrate_get_state', {
    description: 'Get orchestrator queue, history/counts, recent runs/events, and paused state.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }),
  }, async ({ workspace_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const state = store.getOrchestratorState(workspace_id);
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }], structuredContent: state };
  });

  server.registerTool('multicontext_orchestrate_set_paused', {
    description: 'Pause or resume orchestrator run dispatch. Resume starts the queued run with its stored target/provenance.',
    inputSchema: z.object({ workspace_id: z.string().min(1), paused: z.boolean() }),
  }, async ({ workspace_id, paused }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const p = store.setOrchestratorPaused(workspace_id, paused);
    const resumed = p ? null : resumeQueuedRun(workspace_id);
    const body = { paused: p, resumed_run_id: resumed?.run.id || null };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
  });
}

export function clearQ(workspaceId) { QStore.delete(workspaceId); }
export function _internalQStore() { return QStore; }