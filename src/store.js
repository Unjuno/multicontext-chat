import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 2, workspaces: {} };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed?.workspaces) throw new Error('Invalid state file');
      this.state = parsed;
      this.migrateAndRecover();
    } catch (error) {
      throw new Error(`Failed to load state: ${error.message}`);
    }
  }

  migrateAndRecover() {
    let dirty = this.state.version !== 2;
    this.state.version = 2;
    for (const workspace of Object.values(this.state.workspaces)) {
      workspace.compilePrompt ??= defaultCompilePrompt();
      workspace.defaultAgentId ??= '';
      workspace.settings ??= {};
      workspace.settings.allowCrossChatInspect ??= true;
      workspace.settings.allowCrossChatSend ??= true;
      workspace.stats ??= {};
      for (const key of ['broadcasts', 'executions', 'toolEnqueues', 'inspections']) workspace.stats[key] ??= 0;
      workspace.orchestratorQueue ??= [];
      workspace.orchestratorRuns ??= {};
      workspace.orchestratorEvents ??= [];
      workspace.orchestratorPaused ??= false;
      // recover Q items: pending/claimed/dispatched that were in-flight go back to pending
      for (const item of workspace.orchestratorQueue) {
        if (item.state === 'claimed' || item.state === 'dispatched') {
          item.state = 'pending';
          dirty = true;
        }
      }
      for (const run of Object.values(workspace.orchestratorRuns)) {
        if (run.status === 'running' || run.status === 'queued') {
          run.status = 'failed';
          run.finishedAt = now();
          run.error = 'Recovered after restart';
          dirty = true;
        }
      }
      // bound events
      if (workspace.orchestratorEvents.length > 200) {
        workspace.orchestratorEvents = workspace.orchestratorEvents.slice(-200);
        dirty = true;
      }
      for (const member of Object.values(workspace.members ?? {})) {
        member.queue ??= [];
        member.messages ??= [];
        member.current ??= null;
        member.conversationId ??= null;
        member.status ??= 'idle';
        if (member.current) {
          const pendingMessageId = member.current.pendingMessageId;
          if (pendingMessageId) member.messages = member.messages.filter((m) => m.id !== pendingMessageId);
          const item = member.current.item;
          if (item && !member.queue.some((queued) => queued.id === item.id)) member.queue.unshift(item);
          member.current = null;
          member.status = 'idle';
          dirty = true;
        } else if (member.status === 'running') {
          member.status = 'idle';
          dirty = true;
        }
        if (!member.active && member.queue.length) {
          member.queue = [];
          dirty = true;
        }
      }
    }
    if (dirty) this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  listWorkspaces() { return Object.values(this.state.workspaces).map((w) => this.publicWorkspace(w, false)); }
  getWorkspace(id) { return this.state.workspaces[id] ?? null; }
  requireWorkspace(id) { const w = this.getWorkspace(id); if (!w) throw problem('Workspace not found', 404); return w; }
  getMember(workspaceId, memberId) { return this.getWorkspace(workspaceId)?.members?.[memberId] ?? null; }
  requireMember(workspaceId, memberId) {
    const workspace = this.requireWorkspace(workspaceId);
    const member = workspace.members[memberId];
    if (!member) throw problem('Member not found', 404);
    return { workspace, member };
  }

  createWorkspace(input = {}) {
    const id = randomUUID(); const timestamp = now();
    const workspace = {
      id, name: String(input.name || 'MultiContext Workspace'), globalPrompt: String(input.globalPrompt || ''),
      compileAgentId: String(input.compileAgentId || ''), compilePrompt: String(input.compilePrompt || defaultCompilePrompt()),
      defaultAgentId: String(input.defaultAgentId || ''),
      settings: { allowCrossChatInspect: input.settings?.allowCrossChatInspect !== false, allowCrossChatSend: input.settings?.allowCrossChatSend !== false },
      crossChatReceipts: {}, members: {}, createdAt: timestamp, updatedAt: timestamp, lastCompile: null,
      stats: { broadcasts: 0, executions: 0, toolEnqueues: 0, inspections: 0 },
      orchestratorQueue: [], orchestratorRuns: {}, orchestratorEvents: [], orchestratorPaused: false,
    };
    this.state.workspaces[id] = workspace; this.save(); return workspace;
  }

  updateWorkspace(id, patch = {}) {
    const workspace = this.requireWorkspace(id);
    if (patch.name !== undefined) workspace.name = String(patch.name);
    if (patch.globalPrompt !== undefined) workspace.globalPrompt = String(patch.globalPrompt);
    if (patch.compileAgentId !== undefined) workspace.compileAgentId = String(patch.compileAgentId);
    if (patch.compilePrompt !== undefined) workspace.compilePrompt = String(patch.compilePrompt);
    if (patch.defaultAgentId !== undefined) workspace.defaultAgentId = String(patch.defaultAgentId);
    if (patch.settings) {
      if (patch.settings.allowCrossChatInspect !== undefined) workspace.settings.allowCrossChatInspect = Boolean(patch.settings.allowCrossChatInspect);
      if (patch.settings.allowCrossChatSend !== undefined) workspace.settings.allowCrossChatSend = Boolean(patch.settings.allowCrossChatSend);
    }
    workspace.updatedAt = now(); this.save(); return workspace;
  }
  deleteWorkspace(id) { this.requireWorkspace(id); delete this.state.workspaces[id]; this.save(); }

  // Orchestrator: Q, Runs, Events (persistent, bounded) — P0/P1 fixes
  enqueueOrchestrator(workspaceId, prompt, { priority = 1, origin = 'mcp', actor = null, runId = null } = {}) {
    const ws = this.requireWorkspace(workspaceId);
    const activeCount = ws.orchestratorQueue.filter(x => x.state === 'pending' || x.state === 'claimed' || x.state === 'dispatched').length;
    if (activeCount >= 200) {
      throw Object.assign(new Error('Orchestrator queue full (200 active)'), { status: 429, code: 'QUEUE_FULL' });
    }
    // prune terminal history beyond 100
    const terminal = ws.orchestratorQueue.filter(x => x.state === 'done' || x.state === 'failed' || x.state === 'cancelled');
    if (terminal.length > 100) {
      const toRemove = terminal.slice(0, terminal.length - 100);
      ws.orchestratorQueue = ws.orchestratorQueue.filter(x => !toRemove.includes(x));
    }
    const item = { id: randomUUID(), prompt: String(prompt), priority: Number(priority), state: 'pending', origin: String(origin), actor: actor ? String(actor) : null, runId: runId ? String(runId) : null, createdAt: now(), claimedAt: null, dispatchedAt: null, doneAt: null };
    ws.orchestratorQueue.push(item);
    ws.orchestratorQueue.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    this.appendEvent(workspaceId, { type: 'q.enqueued', origin: item.origin, actor: item.actor, runId: item.runId, qId: item.id, detail: { priority: item.priority } });
    this.save();
    return item;
  }
  peekOrchestratorQueue(workspaceId, limit = 10) {
    const ws = this.requireWorkspace(workspaceId);
    // P1: only pending is considered queue; terminal stays in history, not active queue
    const pending = ws.orchestratorQueue.filter(x => x.state === 'pending');
    pending.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    return pending.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
  }
  peekOrchestratorQueueAll(workspaceId, limit = 20) {
    const ws = this.requireWorkspace(workspaceId);
    return ws.orchestratorQueue.slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)));
  }
  listOrchestratorQueueHistory(workspaceId, limit = 50) {
    const ws = this.requireWorkspace(workspaceId);
    const terminal = ws.orchestratorQueue.filter(x => x.state === 'done' || x.state === 'failed' || x.state === 'cancelled');
    return terminal.slice(-Math.max(1, Math.min(Number(limit) || 50, 100)));
  }
  updateOrchestratorQueueItem(workspaceId, qId, patch = {}) {
    const ws = this.requireWorkspace(workspaceId);
    const item = ws.orchestratorQueue.find(x => x.id === qId);
    if (!item) throw problem('Q item not found', 404);
    // P1: state machine validation
    const allowed = {
      pending: ['claimed', 'dispatched', 'cancelled'],
      claimed: ['dispatched', 'failed', 'cancelled'],
      dispatched: ['done', 'failed', 'cancelled'],
      done: [],
      failed: [],
      cancelled: [],
    };
    if (patch.state && patch.state !== item.state) {
      const from = item.state;
      const to = patch.state;
      if (!allowed[from] || !allowed[from].includes(to)) {
        throw problem(`Invalid Q transition ${from} -> ${to}`, 409);
      }
    }
    for (const k of ['state', 'priority']) if (patch[k] !== undefined) item[k] = patch[k];
    if (patch.state === 'claimed') item.claimedAt = now();
    if (patch.state === 'dispatched') item.dispatchedAt = now();
    if (patch.state === 'done' || patch.state === 'failed' || patch.state === 'cancelled') item.doneAt = now();
    // prune terminal beyond 100
    const terminal = ws.orchestratorQueue.filter(x => x.state === 'done' || x.state === 'failed' || x.state === 'cancelled');
    if (terminal.length > 100) {
      const toRemove = terminal.slice(0, terminal.length - 100);
      ws.orchestratorQueue = ws.orchestratorQueue.filter(x => !toRemove.includes(x));
    }
    this.save();
    return item;
  }
  createOrchestratorRun(workspaceId, { prompt, priority = 1, origin = 'mcp', actor = null, qItemIds = [] } = {}) {
    const ws = this.requireWorkspace(workspaceId);
    // P0: one active run per workspace
    const active = Object.values(ws.orchestratorRuns).find(r => r.status === 'queued' || r.status === 'running');
    if (active) throw Object.assign(new Error('Orchestrator run already active'), { status: 409, code: 'ORCHESTRATOR_RUN_ALREADY_ACTIVE' });
    const id = randomUUID();
    const run = { id, workspaceId, prompt: String(prompt || ''), priority: Number(priority), origin: String(origin), actor: actor ? String(actor) : null, qItemIds: Array.isArray(qItemIds) ? qItemIds : [], status: 'queued', createdAt: now(), startedAt: null, finishedAt: null, error: null };
    ws.orchestratorRuns[id] = run;
    // bound runs: keep at most 100, prune oldest terminal
    const allRuns = Object.values(ws.orchestratorRuns);
    if (allRuns.length > 100) {
      const terminal = allRuns.filter(r => ['settled','blocked','failed','cancelled'].includes(r.status)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      const toPrune = terminal.slice(0, allRuns.length - 100);
      for (const r of toPrune) delete ws.orchestratorRuns[r.id];
    }
    this.appendEvent(workspaceId, { type: 'mcp.run.started', origin: run.origin, actor: run.actor, runId: id, detail: { priority } });
    this.save();
    return run;
  }
  getOrchestratorRun(workspaceId, runId) {
    const ws = this.requireWorkspace(workspaceId);
    const run = ws.orchestratorRuns[runId];
    if (!run) throw problem('Run not found', 404);
    return run;
  }
  updateOrchestratorRun(workspaceId, runId, patch = {}) {
    const ws = this.requireWorkspace(workspaceId);
    const run = ws.orchestratorRuns[runId];
    if (!run) throw problem('Run not found', 404);
    // P1: terminal immutability and transition table
    const allowed = {
      queued: ['running', 'cancelled', 'failed'],
      running: ['settled', 'blocked', 'failed', 'cancelled'],
      settled: [],
      blocked: [],
      failed: [],
      cancelled: [],
    };
    if (patch.status && patch.status !== run.status) {
      const from = run.status;
      const to = patch.status;
      if (!allowed[from] || !allowed[from].includes(to)) {
        throw problem(`Invalid run transition ${from} -> ${to}`, 409);
      }
    }
    // terminal already -> no overwrite
    if (['settled','blocked','failed','cancelled'].includes(run.status) && patch.status && patch.status !== run.status) {
      throw problem(`Run already terminal ${run.status}`, 409);
    }
    for (const k of ['status', 'error']) if (patch[k] !== undefined) run[k] = patch[k];
    if (patch.status === 'running' && !run.startedAt) run.startedAt = now();
    if (patch.status === 'settled' || patch.status === 'blocked' || patch.status === 'cancelled' || patch.status === 'failed') {
      run.finishedAt = now();
      // P0: when run becomes cancelled, also cancel its Q items (pending/claimed/dispatched)
      if (patch.status === 'cancelled') {
        for (const q of ws.orchestratorQueue) {
          if (q.runId === runId && (q.state === 'pending' || q.state === 'claimed' || q.state === 'dispatched')) {
            q.state = 'cancelled';
            q.doneAt = now();
          }
        }
      }
    }
    this.appendEvent(workspaceId, { type: `run.${patch.status || 'updated'}`, origin: run.origin, actor: run.actor, runId, detail: patch });
    this.save();
    return run;
  }
  listOrchestratorRuns(workspaceId) {
    const ws = this.requireWorkspace(workspaceId);
    return Object.values(ws.orchestratorRuns).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  appendEvent(workspaceId, { type, origin = 'system', actor = null, runId = null, qId = null, memberId = null, detail = null } = {}) {
    const ws = this.requireWorkspace(workspaceId);
    const ev = { id: randomUUID(), ts: now(), type: String(type), origin: String(origin), actor: actor ? String(actor) : null, runId: runId ? String(runId) : null, qId: qId ? String(qId) : null, memberId: memberId ? String(memberId) : null, detail: detail ?? null };
    ws.orchestratorEvents.push(ev);
    if (ws.orchestratorEvents.length > 200) ws.orchestratorEvents = ws.orchestratorEvents.slice(-200);
    // do not save on every event to avoid excessive I/O? save anyway for persistence
    this.save();
    return ev;
  }
  listOrchestratorEvents(workspaceId, limit = 50) {
    const ws = this.requireWorkspace(workspaceId);
    const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
    return ws.orchestratorEvents.slice(-lim);
  }
  getOrchestratorState(workspaceId) {
    const ws = this.requireWorkspace(workspaceId);
    const pending = ws.orchestratorQueue.filter(x => x.state === 'pending').sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    const history = ws.orchestratorQueue.filter(x => ['done','failed','cancelled'].includes(x.state)).slice(-20);
    const counts = { q0: pending.filter(x=>x.priority===0).length, q1: pending.filter(x=>x.priority===1).length, q2: pending.filter(x=>x.priority===2).length, pending: pending.length, history: history.length };
    return {
      queue: pending.slice(0, 20),
      queueHistory: history,
      counts,
      runs: Object.values(ws.orchestratorRuns).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
      events: ws.orchestratorEvents.slice(-30),
      paused: Boolean(ws.orchestratorPaused),
    };
  }
  setOrchestratorPaused(workspaceId, paused) {
    const ws = this.requireWorkspace(workspaceId);
    ws.orchestratorPaused = Boolean(paused);
    this.appendEvent(workspaceId, { type: paused ? 'orchestrator.paused' : 'orchestrator.resumed', origin: 'human' });
    this.save();
    return ws.orchestratorPaused;
  }
  // P1: run-scoped cancellation of member queue items
  cancelOrchestratorRunMembers(workspaceId, runId) {
    const ws = this.requireWorkspace(workspaceId);
    let cancelled = 0;
    for (const member of Object.values(ws.members)) {
      const before = member.queue.length;
      member.queue = member.queue.filter(item => !(item.orchestratorRunId === runId && item.orchestratorQId));
      cancelled += before - member.queue.length;
      // if current is from this run, abort it (do not clear queue, just current)
      if (member.current && member.current.item && member.current.item.orchestratorRunId === runId) {
        const pendingId = member.current.pendingMessageId;
        if (pendingId) member.messages = member.messages.filter(m => m.id !== pendingId);
        member.current = null;
        member.status = 'idle';
        member.lastError = null;
      }
      member.updatedAt = now();
    }
    ws.updatedAt = now();
    if (cancelled > 0) this.appendEvent(workspaceId, { type: 'run.members.cancelled', origin: 'system', runId, detail: { cancelled } });
    this.save();
    return cancelled;
  }
  // P1: Q done should happen after workspace settled, not immediately after enqueue. Helper to mark dispatched Q as done when run settles
  markDispatchedQDone(workspaceId, runId, finalStatus) {
    const ws = this.requireWorkspace(workspaceId);
    for (const q of ws.orchestratorQueue) {
      if (q.runId === runId && q.state === 'dispatched') {
        q.state = finalStatus === 'settled' ? 'done' : 'failed';
        q.doneAt = now();
      }
    }
    this.save();
  }

  addMember(workspaceId, input = {}) {
    const workspace = this.requireWorkspace(workspaceId); const id = randomUUID();
    const member = {
      id, name: String(input.name || `Agent ${Object.keys(workspace.members).length + 1}`), agentId: String(input.agentId || ''), developerPrompt: String(input.developerPrompt || ''),
      active: input.active !== false, canInspectOthers: input.canInspectOthers !== false, canSendOthers: input.canSendOthers !== false,
      status: 'idle', queue: [], current: null, messages: [], conversationId: null, lastError: null, lastRun: null, createdAt: now(), updatedAt: now(),
    };
    workspace.members[id] = member; workspace.updatedAt = now(); this.save(); return member;
  }

  updateMember(workspaceId, memberId, patch = {}) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    for (const key of ['name', 'agentId', 'developerPrompt']) if (patch[key] !== undefined) member[key] = String(patch[key]);
    for (const key of ['canInspectOthers', 'canSendOthers']) if (patch[key] !== undefined) member[key] = Boolean(patch[key]);
    if (patch.active !== undefined) {
      member.active = Boolean(patch.active);
      if (!member.active) { member.queue = []; member.current = null; member.status = 'idle'; }
    }
    member.updatedAt = now(); workspace.updatedAt = now(); this.save(); return member;
  }
  deleteMember(workspaceId, memberId) {
    const workspace = this.requireWorkspace(workspaceId);
    if (!workspace.members[memberId]) throw problem('Member not found', 404);
    delete workspace.members[memberId]; workspace.updatedAt = now(); this.save();
  }

  resolveMember(workspaceId, reference, { activeOnly = false } = {}) {
    const workspace = this.requireWorkspace(workspaceId); const ref = String(reference || '').trim();
    let member = workspace.members[ref] ?? null;
    if (!member) {
      const matches = Object.values(workspace.members).filter((m) => m.name === ref);
      if (matches.length > 1) throw problem('Member name is ambiguous', 409);
      member = matches[0] ?? null;
    }
    if (!member) throw problem('Target member not found', 404);
    if (activeOnly && !member.active) throw problem('Target member is inactive', 409);
    return member;
  }

  effectiveAgentId(workspaceId, memberId) {
    const workspace = this.requireWorkspace(workspaceId);
    const member = workspace.members[memberId];
    if (!member) throw problem('Member not found', 404);
    return String(member.agentId || workspace.defaultAgentId || '').trim();
  }

  effectiveAgentForWorkspace(workspaceId, fallbackAgentId = '') {
    const workspace = this.requireWorkspace(workspaceId);
    return String(workspace.defaultAgentId || fallbackAgentId || '').trim();
  }

  enqueue(workspaceId, memberId, prompt, metadata = {}) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    if (!member.active) throw problem('Target member is inactive', 409);
    const item = { id: randomUUID(), prompt: String(prompt || '').trim(), attempts: Number(metadata.attempts || 0), source: metadata.source || 'user', sourceMemberId: metadata.sourceMemberId || null, orchestratorRunId: metadata.orchestratorRunId || null, orchestratorQId: metadata.orchestratorQId || null, createdAt: now() };
    if (!item.prompt) throw problem('Prompt is required');
    member.queue.push(item); member.updatedAt = now(); workspace.updatedAt = now();
    if (item.source === 'tool') workspace.stats.toolEnqueues += 1;
    this.save(); return item;
  }

  enqueueCrossChatAtomic(workspaceId, sourceMemberId, queueItemId, toolCallId, targetRefs, prompt) {
    const workspace = this.requireWorkspace(workspaceId);
    const source = workspace.members[sourceMemberId];
    if (!source) throw problem('Source member not found', 404);
    const receiptKey = `${sourceMemberId}:${queueItemId}:${toolCallId}`;
    if (workspace.crossChatReceipts?.[receiptKey]) {
      const prev = workspace.crossChatReceipts[receiptKey].result;
      // Return replayed view without mutating stored original
      if (prev.replayed === true) return prev;
      // legacy stored false should be returned as true on replay
      return { ...prev, replayed: true };
    }
    const refs = Array.isArray(targetRefs) ? targetRefs : [targetRefs];
    if (refs.length < 1 || refs.length > 2) throw problem('targets must contain one or two chats', 400);
    const targets = refs.map(ref => this.resolveMember(workspaceId, ref, { activeOnly: true }));
    if (targets.some(m => m.id === sourceMemberId)) throw problem('Target must be another chat', 400);
    if (new Set(targets.map(m => m.id)).size !== targets.length) throw problem('Targets must be unique', 400);
    const text = String(prompt || '').trim();
    if (!text) throw problem('Prompt is required', 400);
    const items = targets.map(target => {
      const item = { id: randomUUID(), prompt: text, attempts: 0, source: 'tool', sourceMemberId, createdAt: now() };
      target.queue.push(item); target.updatedAt = now(); workspace.updatedAt = now();
      if (item.source === 'tool') workspace.stats.toolEnqueues += 1;
      return { target: { id: target.id, name: target.name }, item };
    });
    if (!workspace.crossChatReceipts) workspace.crossChatReceipts = {};
    workspace.crossChatReceipts[receiptKey] = {
      sourceMemberId, targetIds: targets.map(m => m.id),
      deliveries: items.map(({ target, item }) => ({ targetId: target.id, queueItemId: item.id })),
      result: { accepted: true, replayed: false, deliveries: items.map(({ target, item }) => ({ target, queue_item_id: item.id })) },
      committedAt: now(),
    };
    this.save();
    return workspace.crossChatReceipts[receiptKey].result;
  }

  getCrossChatReceipt(workspaceId, sourceMemberId, queueItemId, toolCallId) {
    const workspace = this.getWorkspace(workspaceId);
    return workspace?.crossChatReceipts?.[`${sourceMemberId}:${queueItemId}:${toolCallId}`] ?? null;
  }

  broadcast(workspaceId, prompt, metadata = {}) {
    const workspace = this.requireWorkspace(workspaceId); const text = String(prompt || '').trim(); if (!text) throw problem('Prompt is required');
    const items = [];
    const source = metadata.orchestratorRunId ? 'orchestrator' : (metadata.source || 'user');
    for (const member of Object.values(workspace.members)) if (member.active) items.push(this.enqueue(workspaceId, member.id, text, { source, sourceMemberId: metadata.sourceMemberId || null, orchestratorRunId: metadata.orchestratorRunId || null, orchestratorQId: metadata.orchestratorQId || null }));
    if (!items.length) throw problem('No active members', 409);
    workspace.stats.broadcasts += 1; this.save(); return items;
  }

  beginNext(workspaceId, memberId) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    if (!member.active || member.current || member.status === 'error') return null;
    const item = member.queue.shift() ?? null; if (!item) return null;
    const pendingMessage = { id: randomUUID(), at: now(), role: 'user', content: item.prompt, pending: true };
    member.messages.push(pendingMessage);
    member.current = { item, pendingMessageId: pendingMessage.id, startedAt: now() };
    member.status = 'running'; member.lastError = null; member.lastRun = { queueItemId: item.id, prompt: item.prompt, startedAt: member.current.startedAt };
    member.updatedAt = now(); workspace.updatedAt = now(); this.save();
    return { item: structuredClone(item), history: member.messages.filter((m) => m.id !== pendingMessage.id).map(stripPrivateMessageFields), conversationId: member.conversationId };
  }

  completeRun(workspaceId, memberId, queueItemId, result = {}) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    if (member.current?.item?.id !== queueItemId) return false;
    const pending = member.messages.find((m) => m.id === member.current.pendingMessageId); if (pending) delete pending.pending;
    member.messages.push({ id: randomUUID(), at: now(), role: 'assistant', content: String(result.text || ''), responseId: result.id || null, usage: result.usage ?? null });
    if (result.conversationId) member.conversationId = result.conversationId;
    member.current = null; member.status = 'idle'; member.lastError = null; member.lastRun = { ...member.lastRun, finishedAt: now(), responseId: result.id || null };
    workspace.stats.executions += 1; member.updatedAt = now(); workspace.updatedAt = now(); this.save(); return true;
  }

  failRun(workspaceId, memberId, queueItemId, errorMessage, { requeue = true } = {}) {
    const record = this.getMember(workspaceId, memberId); if (!record || record.current?.item?.id !== queueItemId) return false;
    const workspace = this.requireWorkspace(workspaceId); const member = record;
    member.messages = member.messages.filter((m) => m.id !== member.current.pendingMessageId);
    const item = { ...member.current.item, attempts: Number(member.current.item.attempts || 0) + 1 };
    if (requeue && member.active && !member.queue.some((q) => q.id === item.id)) member.queue.unshift(item);
    member.current = null; member.status = requeue ? 'error' : 'idle'; member.lastError = String(errorMessage || 'Run failed');
    member.updatedAt = now(); workspace.updatedAt = now(); this.save(); return true;
  }

  cancelCurrent(workspaceId, memberId, { clearQueue = true } = {}) {
    const record = this.getMember(workspaceId, memberId); if (!record) return;
    const workspace = this.requireWorkspace(workspaceId); const member = record;
    if (member.current) member.messages = member.messages.filter((m) => m.id !== member.current.pendingMessageId);
    member.current = null; if (clearQueue) member.queue = []; member.status = 'idle'; member.lastError = null; member.updatedAt = now(); workspace.updatedAt = now(); this.save();
  }

  retryMember(workspaceId, memberId) {
    const { member } = this.requireMember(workspaceId, memberId);
    if (!member.active) throw problem('Member is inactive', 409); if (member.current) throw problem('Member is running', 409);
    member.status = 'idle'; member.lastError = null; member.updatedAt = now(); this.save();
  }

  clearQueues(workspaceId) { const w = this.requireWorkspace(workspaceId); for (const m of Object.values(w.members)) m.queue = []; w.updatedAt = now(); this.save(); }
  trimMessages(workspaceId, memberId, max) { const { member } = this.requireMember(workspaceId, memberId); if (member.messages.length > max) member.messages = member.messages.slice(-max); this.save(); }
  setCompile(workspaceId, result) { const w = this.requireWorkspace(workspaceId); w.lastCompile = { ...result, at: now() }; w.updatedAt = now(); this.save(); }

  runtimeState(workspaceId, runningMemberIds = new Set()) {
    const workspace = this.requireWorkspace(workspaceId); const active = Object.values(workspace.members).filter((m) => m.active);
    if (active.some((m) => m.current || m.status === 'running' || runningMemberIds.has(m.id))) return 'RUNNING';
    if (active.some((m) => m.status === 'error')) return 'BLOCKED';
    if (active.some((m) => m.queue.length > 0)) return 'PENDING';
    return 'SETTLED';
  }
  isSettled(workspaceId, runningMemberIds = new Set()) { return this.runtimeState(workspaceId, runningMemberIds) === 'SETTLED'; }
  publicWorkspace(workspace, includeMessages = true) {
    const { crossChatReceipts: _r, orchestratorQueue: _q, orchestratorRuns: _runs, orchestratorEvents: _ev, orchestratorPaused: _p, ...rest } = workspace;
    return { ...rest, members: Object.fromEntries(Object.entries(workspace.members).map(([id, m]) => [id, publicMember(m, includeMessages)])) };
  }
}

export function publicMember(member, includeMessages = true) {
  const { conversationId: _cid, current: _cur, lastRun: _lr, ...rest } = member;
  return { ...rest, inFlight: Boolean(member.current), messages: includeMessages ? member.messages : [] };
}

const stripPrivateMessageFields = (m) => ({ role: m.role, content: String(m.content || '') });

export function searchMemberMessages(member, query, limit = 8) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = member.messages.filter((m) => !m.pending).map((message, index) => {
    const text = String(message.content || '').toLowerCase(); const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 3 : 0), 0) + index / 10000;
    return { message, score };
  });
  const filtered = tokens.length ? scored.filter((x) => x.score >= 3) : scored.slice(-limit);
  return filtered.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 8, 20))).map(({ message }) => ({ id: message.id, role: message.role, at: message.at, content: String(message.content || '').slice(0, 4000) }));
}

export function defaultCompilePrompt() {
  return 'Compress the supplied independent chat records into one clear response. Preserve material differences and unresolved points. Do not invent information that is not present in the records.';
}
