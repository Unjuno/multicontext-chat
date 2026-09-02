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

// Preset persona templates for demo (Navier-Stokes)
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

export function registerOrchestratorTools(server, app, store) {
  const hasStore = store && typeof store.createOrchestratorRun === 'function';

  server.registerTool('multicontext_orchestrate_create_session', {
    description: 'Create a workspace with preset personas and seed Q with initial tasks. Returns workspace and member ids. This is the entry point for orchestrated multi-agent sessions.',
    inputSchema: z.object({
      preset: z.enum(['navier-stokes-4']).optional(),
      name: z.string().optional(),
      globalPrompt: z.string().optional(),
    }),
  }, async ({ preset, name, globalPrompt }) => {
    const p = PRESETS[preset || 'navier-stokes-4'];
    const ws = await app.createWorkspace({ name: name || p.name, globalPrompt: globalPrompt || '' });
    const members = [];
    for (const m of p.members) {
      const r = await app.addChat(ws.id, { name: m.name, developerPrompt: m.developerPrompt });
      members.push(r.member);
    }
    if (hasStore) {
      store.enqueueOrchestrator(ws.id, p.seedPrompt, { priority: 0, origin: 'mcp', actor: 'orchestrator' });
      store.appendEvent(ws.id, { type: 'mcp.run.started', origin: 'mcp', detail: { preset } });
    } else {
      pushQ(ws.id, p.seedPrompt, 0);
    }
    const view = await app.getWorkspace(ws.id);
    const q = hasStore ? store.peekOrchestratorQueue(ws.id) : peekQ(ws.id);
    return { content: [{ type: 'text', text: JSON.stringify({ workspace: view, members, q }, null, 2) }], structuredContent: { workspace: view, members, q } };
  });

  server.registerTool('multicontext_orchestrate_enqueue', {
    description: 'Enqueue a prompt to Q with priority (0=highest, 1=normal, 2=background). Pure Q operation: enqueues as pending, does not immediately dispatch. Use start_run or wait for dispatcher to execute. For immediate dispatch, use broadcast/send directly.',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      prompt: z.string().min(1),
      priority: z.number().int().min(0).max(2).optional(),
      broadcast: z.boolean().optional(),
      chat_id: z.string().optional(),
    }),
  }, async ({ workspace_id, prompt, priority, broadcast, chat_id }) => {
    const pr = priority ?? 1;
    // P1: standalone enqueue is pure Q, no immediate dispatch, no dispatched forever
    let target = null;
    if (broadcast) target = { type: 'broadcast' };
    else if (chat_id) target = { type: 'member', memberId: chat_id };
    let qItem;
    if (hasStore) qItem = store.enqueueOrchestrator(workspace_id, prompt, { priority: pr, origin: 'mcp', actor: 'orchestrator', target });
    else qItem = pushQ(workspace_id, prompt, pr);
    // do not dispatch here; Q remains pending until a Run dispatches it
    const q = hasStore ? store.peekOrchestratorQueue(workspace_id) : peekQ(workspace_id);
    return { content: [{ type: 'text', text: JSON.stringify({ qItem, queued: true, hint: 'Use start_run to dispatch' }, null, 2) }], structuredContent: { qItem, queued: true, q } };
  });

  server.registerTool('multicontext_orchestrate_next', {
    description: 'Pop the next Q item (highest priority) and optionally dequeue it. Use to let a sub-agent claim the next task.',
    inputSchema: z.object({ workspace_id: z.string().min(1), pop: z.boolean().optional() }),
  }, async ({ workspace_id, pop }) => {
    if (hasStore) {
      const q = store.peekOrchestratorQueue(workspace_id, 1);
      const item = q[0] || null;
      if (pop && item) {
        store.updateOrchestratorQueueItem(workspace_id, item.id, { state: 'claimed' });
      }
      return { content: [{ type: 'text', text: JSON.stringify({ item, q: store.peekOrchestratorQueue(workspace_id) }, null, 2) }], structuredContent: { item, q: store.peekOrchestratorQueue(workspace_id) } };
    }
    const item = pop ? popQ(workspace_id) : peekQ(workspace_id, 1)[0] || null;
    return { content: [{ type: 'text', text: JSON.stringify({ item, q: peekQ(workspace_id) }, null, 2) }], structuredContent: { item, q: peekQ(workspace_id) } };
  });

  server.registerTool('multicontext_orchestrate_distill_context', {
    description: 'Distill a chat or workspace context into a token-bounded summary for handoff to a sub-agent. Uses bounded history and compile-style compression without extra LLM call (deterministic).',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      chat_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  }, async ({ workspace_id, chat_id, limit }) => {
    const lim = limit ?? 12;
    if (chat_id) {
      const msgs = await app.getChatMessages(workspace_id, chat_id, { limit: lim });
      const distilled = msgs.map(m => `${m.role}: ${m.content.slice(0,400)}`).join('\n---\n');
      return { content: [{ type: 'text', text: distilled }], structuredContent: { messages: msgs, distilled } };
    }
    const ws = await app.getWorkspace(workspace_id, { includeMessages: true, boundedMessages: lim });
    const all = Object.values(ws.members).map(m => `## ${m.name} (${m.id})\n${(m.messages||[]).slice(-lim).map(x=>`${x.role}: ${String(x.content).slice(0,300)}`).join('\n')}`).join('\n\n');
    return { content: [{ type: 'text', text: all.slice(0,8000) }], structuredContent: { workspace: ws, distilled: all.slice(0,8000) } };
  });

  server.registerTool('multicontext_orchestrate_extract_findings', {
    description: 'Extract A-F style findings from a workspace: independent conclusions, cross-chat citations, disagreements, and unresolved points. Returns structured report.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }),
  }, async ({ workspace_id }) => {
    const ws = await app.getWorkspace(workspace_id, { includeMessages: true, boundedMessages: 20 });
    const findings = {
      workspace: { id: ws.id, name: ws.name, runtimeState: ws.runtimeState },
      members: Object.values(ws.members).map(m => ({
        id: m.id, name: m.name,
        lastMessage: (m.messages||[]).slice(-1)[0]?.content?.slice(0,500) || null,
        messageCount: m.messages?.length || 0,
        status: m.status,
      })),
      compile: ws.lastCompile,
      stats: ws.stats,
      q: hasStore ? store.peekOrchestratorQueue(workspace_id) : peekQ(workspace_id),
      events: hasStore ? store.listOrchestratorEvents(workspace_id, 10) : [],
    };
    return { content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }], structuredContent: findings };
  });

  server.registerTool('multicontext_orchestrate_join_as_member', {
    description: 'Join an existing workspace as a new sub-agent member with a custom developer prompt. Useful for dynamic sub-agent spawning.',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      name: z.string().min(1).max(100),
      developer_prompt: z.string().optional(),
      agent_id: z.string().optional(),
    }),
  }, async ({ workspace_id, name, developer_prompt, agent_id }) => {
    const r = await app.addChat(workspace_id, { name, developerPrompt: developer_prompt || '', agentId: agent_id || '' });
    if (hasStore) store.appendEvent(workspace_id, { type: 'mcp.member.joined', origin: 'mcp', memberId: r.member.id, detail: { name } });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r };
  });

  // Unified auto-run: now a compat wrapper around start_run (single execution engine)
  server.registerTool('multicontext_orchestrate_run', {
    description: 'Auto-run (compat wrapper): delegates to start_run and waits. Use start_run for async long runs.',
    inputSchema: z.object({
      workspace_id: z.string().optional(),
      preset: z.enum(['navier-stokes-4']).optional(),
      name: z.string().optional(),
      prompt: z.string().min(1),
      priority: z.number().int().min(0).max(2).optional(),
      broadcast: z.boolean().optional(),
      chat_id: z.string().optional(),
      timeout_seconds: z.number().min(5).max(300).optional(),
    }),
  }, async (args) => {
    // delegate to start_run then poll
    let wsId = args.workspace_id;
    if (!wsId) {
      const p = PRESETS[args.preset || 'navier-stokes-4'];
      const ws = await app.createWorkspace({ name: args.name || p.name });
      for (const m of p.members) await app.addChat(ws.id, { name: m.name, developerPrompt: m.developerPrompt });
      wsId = ws.id;
    }
    // create a proper async run via store so lifecycle is unified
    if (hasStore) {
      const run = store.createOrchestratorRun(wsId, { prompt: args.prompt, priority: args.priority ?? 1, origin: 'mcp', actor: 'orchestrator' });
      const qItem = store.enqueueOrchestrator(wsId, args.prompt, { priority: args.priority ?? 1, origin: 'mcp', actor: 'orchestrator', runId: run.id });
      // respect pause gate
      const ws = store.getWorkspace(wsId);
      if (ws.orchestratorPaused) {
        return { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wsId, run_id: run.id, queued: true, paused: true, qItem }, null, 2) }], structuredContent: { workspace_id: wsId, run_id: run.id, queued: true, paused: true } };
      }
      store.updateOrchestratorRun(wsId, run.id, { status: 'running' });
      store.updateOrchestratorQueueItem(wsId, qItem.id, { state: 'dispatched' });
      let enqueueResult;
      try {
        if (args.broadcast) enqueueResult = await app.broadcast(wsId, args.prompt);
        else if (args.chat_id) enqueueResult = await app.send(wsId, args.chat_id, args.prompt);
        else enqueueResult = await app.broadcast(wsId, args.prompt);
      } catch (e) {
        store.updateOrchestratorRun(wsId, run.id, { status: 'failed', error: String(e.message || e) });
        store.updateOrchestratorQueueItem(wsId, qItem.id, { state: 'failed' });
        throw e;
      }
      const wait = await app.waitUntilSettled(wsId, args.timeout_seconds ?? 120, 500);
      // check terminal race: if run was cancelled in the meantime, do not overwrite
      const curRun = store.getOrchestratorRun(wsId, run.id);
      if (curRun.status !== 'cancelled') {
        const finalStatus = wait.state === 'SETTLED' ? 'settled' : wait.state === 'BLOCKED' ? 'blocked' : 'failed';
        store.updateOrchestratorRun(wsId, run.id, { status: finalStatus });
        store.updateOrchestratorQueueItem(wsId, qItem.id, { state: finalStatus === 'settled' ? 'done' : 'failed' });
      }
      const q = store.peekOrchestratorQueue(wsId);
      return { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wsId, run_id: run.id, enqueueResult, wait, q }, null, 2) }], structuredContent: { workspace_id: wsId, run_id: run.id, enqueueResult, wait, q } };
    }
    // fallback in-memory
    let enqueueResult;
    if (args.broadcast) enqueueResult = await app.broadcast(wsId, args.prompt);
    else if (args.chat_id) enqueueResult = await app.send(wsId, args.chat_id, args.prompt);
    else enqueueResult = await app.broadcast(wsId, args.prompt);
    const wait = await app.waitUntilSettled(wsId, args.timeout_seconds ?? 120, 500);
    return { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wsId, enqueueResult, wait }, null, 2) }], structuredContent: { workspace_id: wsId, enqueueResult, wait } };
  });

  // Async Run model: start → run_id immediate, poll via get/cancel (P1: pause gate, single active run, race-safe, target preservation)
  server.registerTool('multicontext_orchestrate_start_run', {
    description: 'Start an async orchestrator run (non-blocking). Returns run_id immediately. Poll with multicontext_orchestrate_get_run. For long sessions, this avoids MCP timeout.',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      prompt: z.string().min(1),
      priority: z.number().int().min(0).max(2).optional(),
      broadcast: z.boolean().optional(),
      chat_id: z.string().optional(),
    }),
  }, async ({ workspace_id, prompt, priority, broadcast, chat_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    // determine target for Q
    const target = broadcast ? { type: 'broadcast' } : chat_id ? { type: 'member', memberId: chat_id } : { type: 'broadcast' };
    // P1: pause gate - do not dispatch if paused, keep queued
    const wsCheck = store.getWorkspace(workspace_id);
    if (wsCheck.orchestratorPaused) {
      const run = store.createOrchestratorRun(workspace_id, { prompt, priority: priority ?? 1, origin: 'mcp', actor: 'orchestrator' });
      const qItem = store.enqueueOrchestrator(workspace_id, prompt, { priority: priority ?? 1, origin: 'mcp', actor: 'orchestrator', runId: run.id, target });
      // keep queued, not running
      return { content: [{ type: 'text', text: JSON.stringify({ run_id: run.id, workspace_id, qItem, paused: true, run }, null, 2) }], structuredContent: { run_id: run.id, workspace_id, qItem, paused: true, run } };
    }
    let run, qItem;
    try {
      run = store.createOrchestratorRun(workspace_id, { prompt, priority: priority ?? 1, origin: 'mcp', actor: 'orchestrator' });
    } catch (e) {
      if (e.code === 'ORCHESTRATOR_RUN_ALREADY_ACTIVE') throw Object.assign(new Error('An orchestrator run is already active for this workspace'), { status: 409, code: e.code });
      throw e;
    }
    qItem = store.enqueueOrchestrator(workspace_id, prompt, { priority: priority ?? 1, origin: 'mcp', actor: 'orchestrator', runId: run.id, target });
    // dispatch without waiting
    (async () => {
      try {
        store.updateOrchestratorRun(workspace_id, run.id, { status: 'running' });
        store.updateOrchestratorQueueItem(workspace_id, qItem.id, { state: 'dispatched' });
        let result;
        const t = qItem.target || target;
        if (t.type === 'broadcast') result = await app.broadcast(workspace_id, prompt, { orchestratorRunId: run.id, orchestratorQId: qItem.id });
        else if (t.type === 'member') result = await app.send(workspace_id, t.memberId, prompt, { orchestratorRunId: run.id, orchestratorQId: qItem.id });
        else result = await app.broadcast(workspace_id, prompt, { orchestratorRunId: run.id, orchestratorQId: qItem.id });
        store.appendEvent(workspace_id, { type: 'q.dispatched', origin: 'mcp', runId: run.id, qId: qItem.id });
        const wait = await app.waitUntilSettled(workspace_id, 300, 500);
        // P1: check terminal race - if cancelled, do not overwrite
        const cur = store.getOrchestratorRun(workspace_id, run.id);
        if (['cancelled','settled','blocked','failed'].includes(cur.status) && cur.status !== 'running') {
          return;
        }
        const finalStatus = wait.state === 'SETTLED' ? 'settled' : wait.state === 'BLOCKED' ? 'blocked' : 'failed';
        store.updateOrchestratorRun(workspace_id, run.id, { status: finalStatus });
        const qState = finalStatus === 'settled' ? 'done' : 'failed';
        try { store.updateOrchestratorQueueItem(workspace_id, qItem.id, { state: qState }); } catch {}
        // mark dispatched Q done
        try { store.markDispatchedQDone(workspace_id, run.id, finalStatus); } catch {}
      } catch (e) {
        try {
          const cur = store.getOrchestratorRun(workspace_id, run.id);
          if (cur && ['cancelled','settled','blocked','failed'].includes(cur.status)) return;
          store.updateOrchestratorRun(workspace_id, run.id, { status: 'failed', error: String(e.message || e) });
        } catch {}
        try { store.updateOrchestratorQueueItem(workspace_id, qItem.id, { state: 'failed' }); } catch {}
      }
    })();
    return { content: [{ type: 'text', text: JSON.stringify({ run_id: run.id, workspace_id, qItem }, null, 2) }], structuredContent: { run_id: run.id, workspace_id, qItem, run } };
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
    description: 'Cancel a running orchestrator run. Only cancels that run and its Q items and member work from that run; does not destroy unrelated human/cross-chat work.',
    inputSchema: z.object({ workspace_id: z.string().min(1), run_id: z.string().min(1) }),
  }, async ({ workspace_id, run_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const run = store.getOrchestratorRun(workspace_id, run_id);
    if (run.status === 'running' || run.status === 'queued') {
      store.updateOrchestratorRun(workspace_id, run_id, { status: 'cancelled' });
      // P0 fix: only cancel Q items belonging to this run, not entire workspace
      const ws = store.getWorkspace(workspace_id);
      const qItems = ws.orchestratorQueue.filter(x => x.runId === run_id && (x.state === 'pending' || x.state === 'claimed' || x.state === 'dispatched'));
      for (const q of qItems) {
        try { store.updateOrchestratorQueueItem(workspace_id, q.id, { state: 'cancelled' }); } catch {}
      }
      // P1: also cancel member queue items that were created by this run (provenance)
      try { store.cancelOrchestratorRunMembers(workspace_id, run_id); } catch {}
      store.appendEvent(workspace_id, { type: 'run.cancelled', origin: 'mcp', runId: run_id });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ run: store.getOrchestratorRun(workspace_id, run_id) }, null, 2) }], structuredContent: { run: store.getOrchestratorRun(workspace_id, run_id) } };
  });

  server.registerTool('multicontext_orchestrate_get_state', {
    description: 'Get full orchestrator state: queue (Q0/Q1/Q2), recent runs, recent events, paused flag. For GUI observability.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }),
  }, async ({ workspace_id }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const state = store.getOrchestratorState(workspace_id);
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }], structuredContent: state };
  });

  server.registerTool('multicontext_orchestrate_set_paused', {
    description: 'Pause or resume Q dispatch. Human override for autonomous runs.',
    inputSchema: z.object({ workspace_id: z.string().min(1), paused: z.boolean() }),
  }, async ({ workspace_id, paused }) => {
    if (!hasStore) throw new Error('Orchestrator store not available');
    const p = store.setOrchestratorPaused(workspace_id, paused);
    // P1: resume dispatcher - if unpaused, try to dispatch next pending Q/run
    if (!p) {
      try {
        const pendingRuns = store.listOrchestratorRuns(workspace_id).filter(r=>r.status==='queued');
        const pendingQ = store.peekOrchestratorQueue(workspace_id, 1);
        if (pendingRuns.length>0 && pendingQ.length>0) {
          const nextRun = pendingRuns.sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
          const nextQ = pendingQ[0];
          // dispatch it
          store.updateOrchestratorRun(workspace_id, nextRun.id, { status: 'running' });
          store.updateOrchestratorQueueItem(workspace_id, nextQ.id, { state: 'dispatched' });
          // fire and forget the actual app dispatch
          (async()=>{
            try {
              await app.broadcast(workspace_id, nextQ.prompt);
              const wait = await app.waitUntilSettled(workspace_id, 300, 500);
              const finalStatus = wait.state==='SETTLED'?'settled':wait.state==='BLOCKED'?'blocked':'failed';
              const cur=store.getOrchestratorRun(workspace_id, nextRun.id);
              if (['cancelled','settled','blocked','failed'].includes(cur.status) && cur.status!=='running') return;
              store.updateOrchestratorRun(workspace_id, nextRun.id, { status: finalStatus });
              store.markDispatchedQDone(workspace_id, nextRun.id, finalStatus);
            } catch(e){
              try{ store.updateOrchestratorRun(workspace_id, nextRun.id, { status: 'failed', error: String(e.message||e) }); }catch{}
              try{ store.updateOrchestratorQueueItem(workspace_id, nextQ.id, { state: 'failed' }); }catch{}
            }
          })();
        }
      } catch {}
    }
    return { content: [{ type: 'text', text: JSON.stringify({ paused: p }, null, 2) }], structuredContent: { paused: p } };
  });
}

export function clearQ(workspaceId) { QStore.delete(workspaceId); }
export function _internalQStore() { return QStore; }
