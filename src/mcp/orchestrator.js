import * as z from 'zod';

// In-memory Q (priority queue) per workspace: Map<workspaceId, Array<{id, prompt, priority, createdAt}>>
// Q0 = highest (verify), Q1 = normal, Q2 = background
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

export function registerOrchestratorTools(server, app) {
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
    // seed Q0 with seedPrompt broadcast task
    pushQ(ws.id, p.seedPrompt, 0);
    const view = await app.getWorkspace(ws.id);
    return { content: [{ type: 'text', text: JSON.stringify({ workspace: view, members, q: peekQ(ws.id) }, null, 2) }], structuredContent: { workspace: view, members, q: peekQ(ws.id) } };
  });

  server.registerTool('multicontext_orchestrate_enqueue', {
    description: 'Enqueue a prompt with Q priority (0=highest, 1=normal, 2=background). For broadcast set broadcast=true, otherwise specify chat_id. Q is ordered by priority then FIFO.',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      prompt: z.string().min(1),
      priority: z.number().int().min(0).max(2).optional(),
      broadcast: z.boolean().optional(),
      chat_id: z.string().optional(),
    }),
  }, async ({ workspace_id, prompt, priority, broadcast, chat_id }) => {
    const pr = priority ?? 1;
    const qItem = pushQ(workspace_id, prompt, pr);
    let result;
    if (broadcast) {
      result = await app.broadcast(workspace_id, prompt);
    } else if (chat_id) {
      result = await app.send(workspace_id, chat_id, prompt);
    } else {
      // Q only, no immediate send
      result = { qItem, queued: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ qItem, result }, null, 2) }], structuredContent: { qItem, result, q: peekQ(workspace_id) } };
  });

  server.registerTool('multicontext_orchestrate_next', {
    description: 'Pop the next Q item (highest priority) and optionally dequeue it. Use to let a sub-agent claim the next task.',
    inputSchema: z.object({ workspace_id: z.string().min(1), pop: z.boolean().optional() }),
  }, async ({ workspace_id, pop }) => {
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
      q: peekQ(workspace_id),
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
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r };
  });

  // Unified auto-run: same path as UI chat (app.*) but via MCP, auto-starts and waits for SETTLED so user sees same behavior
  server.registerTool('multicontext_orchestrate_run', {
    description: 'Auto-run: enqueue (broadcast or direct) via same app.* path as chat UI, then wait until SETTLED. MCP and chat behave identically; user sees progress in UI. Handles Q priority and auto-creation.',
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
  }, async ({ workspace_id, preset, name, prompt, priority, broadcast, chat_id, timeout_seconds }) => {
    let wsId = workspace_id;
    // auto-create if needed
    if (!wsId) {
      const p = PRESETS[preset || 'navier-stokes-4'];
      const ws = await app.createWorkspace({ name: name || p.name });
      for (const m of p.members) await app.addChat(ws.id, { name: m.name, developerPrompt: m.developerPrompt });
      wsId = ws.id;
    }
    const pr = priority ?? 1;
    pushQ(wsId, prompt, pr);
    let enqueueResult;
    if (broadcast) enqueueResult = await app.broadcast(wsId, prompt);
    else if (chat_id) enqueueResult = await app.send(wsId, chat_id, prompt);
    else enqueueResult = await app.broadcast(wsId, prompt);
    // wait same as UI does: poll until SETTLED/BLOCKED
    const wait = await app.waitUntilSettled(wsId, timeout_seconds ?? 120, 500);
    const distilled = await app.getWorkspace(wsId, { includeMessages: true, boundedMessages: 8 });
    return { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wsId, enqueueResult, wait, q: peekQ(wsId), distilled: Object.values(distilled.members).map(m=>`${m.name}:${(m.messages||[]).slice(-1)[0]?.content?.slice(0,200)}`).join(' | ') }, null, 2) }], structuredContent: { workspace_id: wsId, enqueueResult, wait, q: peekQ(wsId) } };
  });
}

export function clearQ(workspaceId) { QStore.delete(workspaceId); }
export function _internalQStore() { return QStore; }
