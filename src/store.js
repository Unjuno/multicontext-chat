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
      members: {}, createdAt: timestamp, updatedAt: timestamp, lastCompile: null,
      stats: { broadcasts: 0, executions: 0, toolEnqueues: 0, inspections: 0 },
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
    const item = { id: randomUUID(), prompt: String(prompt || '').trim(), attempts: Number(metadata.attempts || 0), source: metadata.source || 'user', sourceMemberId: metadata.sourceMemberId || null, createdAt: now() };
    if (!item.prompt) throw problem('Prompt is required');
    member.queue.push(item); member.updatedAt = now(); workspace.updatedAt = now();
    if (item.source === 'tool') workspace.stats.toolEnqueues += 1;
    this.save(); return item;
  }

  broadcast(workspaceId, prompt) {
    const workspace = this.requireWorkspace(workspaceId); const text = String(prompt || '').trim(); if (!text) throw problem('Prompt is required');
    const items = [];
    for (const member of Object.values(workspace.members)) if (member.active) items.push(this.enqueue(workspaceId, member.id, text, { source: 'user' }));
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
  publicWorkspace(workspace, includeMessages = true) { return { ...workspace, members: Object.fromEntries(Object.entries(workspace.members).map(([id, m]) => [id, publicMember(m, includeMessages)])) }; }
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
