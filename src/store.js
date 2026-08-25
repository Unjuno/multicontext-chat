import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, workspaces: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed?.version === 1 && parsed?.workspaces) this.state = parsed;
      }
    } catch (error) {
      throw new Error(`Failed to load state: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  listWorkspaces() {
    return Object.values(this.state.workspaces).map((w) => this.publicWorkspace(w, false));
  }

  getWorkspace(id) {
    return this.state.workspaces[id] ?? null;
  }

  requireWorkspace(id) {
    const workspace = this.getWorkspace(id);
    if (!workspace) throw Object.assign(new Error('Workspace not found'), { status: 404 });
    return workspace;
  }

  requireMember(workspaceId, memberId) {
    const workspace = this.requireWorkspace(workspaceId);
    const member = workspace.members[memberId];
    if (!member) throw Object.assign(new Error('Member not found'), { status: 404 });
    return { workspace, member };
  }

  createWorkspace(input = {}) {
    const id = randomUUID();
    const timestamp = now();
    const workspace = {
      id,
      name: String(input.name || 'MultiContext Workspace'),
      globalPrompt: String(input.globalPrompt || ''),
      compileAgentId: String(input.compileAgentId || ''),
      compilePrompt: String(input.compilePrompt || defaultCompilePrompt()),
      settings: {
        allowCrossChatInspect: input.settings?.allowCrossChatInspect !== false,
        allowCrossChatSend: input.settings?.allowCrossChatSend !== false,
      },
      members: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      lastCompile: null,
      stats: { broadcasts: 0, executions: 0, toolEnqueues: 0, inspections: 0 },
    };
    this.state.workspaces[id] = workspace;
    this.save();
    return workspace;
  }

  updateWorkspace(id, patch = {}) {
    const workspace = this.requireWorkspace(id);
    if (patch.name !== undefined) workspace.name = String(patch.name);
    if (patch.globalPrompt !== undefined) workspace.globalPrompt = String(patch.globalPrompt);
    if (patch.compileAgentId !== undefined) workspace.compileAgentId = String(patch.compileAgentId);
    if (patch.compilePrompt !== undefined) workspace.compilePrompt = String(patch.compilePrompt);
    if (patch.settings) workspace.settings = { ...workspace.settings, ...patch.settings };
    workspace.updatedAt = now();
    this.save();
    return workspace;
  }

  deleteWorkspace(id) {
    this.requireWorkspace(id);
    delete this.state.workspaces[id];
    this.save();
  }

  addMember(workspaceId, input = {}) {
    const workspace = this.requireWorkspace(workspaceId);
    const id = randomUUID();
    const member = {
      id,
      name: String(input.name || `Agent ${Object.keys(workspace.members).length + 1}`),
      agentId: String(input.agentId || ''),
      developerPrompt: String(input.developerPrompt || ''),
      active: input.active !== false,
      canInspectOthers: input.canInspectOthers !== false,
      canSendOthers: input.canSendOthers !== false,
      status: 'idle',
      queue: [],
      messages: [],
      lastError: null,
      lastRun: null,
      createdAt: now(),
      updatedAt: now(),
    };
    workspace.members[id] = member;
    workspace.updatedAt = now();
    this.save();
    return member;
  }

  updateMember(workspaceId, memberId, patch = {}) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    for (const key of ['name', 'agentId', 'developerPrompt']) {
      if (patch[key] !== undefined) member[key] = String(patch[key]);
    }
    for (const key of ['active', 'canInspectOthers', 'canSendOthers']) {
      if (patch[key] !== undefined) member[key] = Boolean(patch[key]);
    }
    member.updatedAt = now();
    workspace.updatedAt = now();
    this.save();
    return member;
  }

  deleteMember(workspaceId, memberId) {
    const workspace = this.requireWorkspace(workspaceId);
    if (!workspace.members[memberId]) throw Object.assign(new Error('Member not found'), { status: 404 });
    delete workspace.members[memberId];
    workspace.updatedAt = now();
    this.save();
  }

  enqueue(workspaceId, memberId, prompt, metadata = {}) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    const item = {
      id: randomUUID(),
      prompt: String(prompt || '').trim(),
      source: metadata.source || 'user',
      sourceMemberId: metadata.sourceMemberId || null,
      createdAt: now(),
    };
    if (!item.prompt) throw Object.assign(new Error('Prompt is required'), { status: 400 });
    member.queue.push(item);
    member.updatedAt = now();
    workspace.updatedAt = now();
    if (item.source === 'tool') workspace.stats.toolEnqueues += 1;
    this.save();
    return item;
  }

  broadcast(workspaceId, prompt) {
    const workspace = this.requireWorkspace(workspaceId);
    const items = [];
    for (const member of Object.values(workspace.members)) {
      if (member.active) items.push(this.enqueue(workspaceId, member.id, prompt, { source: 'user' }));
    }
    workspace.stats.broadcasts += 1;
    this.save();
    return items;
  }

  shiftQueue(workspaceId, memberId) {
    const { member } = this.requireMember(workspaceId, memberId);
    const item = member.queue.shift() ?? null;
    this.save();
    return item;
  }

  clearQueues(workspaceId) {
    const workspace = this.requireWorkspace(workspaceId);
    for (const member of Object.values(workspace.members)) member.queue = [];
    workspace.updatedAt = now();
    this.save();
  }

  appendMessage(workspaceId, memberId, message) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    member.messages.push({ id: randomUUID(), at: now(), ...message });
    member.updatedAt = now();
    workspace.updatedAt = now();
    this.save();
  }

  trimMessages(workspaceId, memberId, max) {
    const { member } = this.requireMember(workspaceId, memberId);
    if (member.messages.length > max) member.messages = member.messages.slice(-max);
    this.save();
  }

  setMemberRuntime(workspaceId, memberId, patch) {
    const { workspace, member } = this.requireMember(workspaceId, memberId);
    Object.assign(member, patch, { updatedAt: now() });
    workspace.updatedAt = now();
    this.save();
  }

  setCompile(workspaceId, result) {
    const workspace = this.requireWorkspace(workspaceId);
    workspace.lastCompile = { ...result, at: now() };
    workspace.updatedAt = now();
    this.save();
  }

  isSettled(workspaceId, runningMemberIds = new Set()) {
    const workspace = this.requireWorkspace(workspaceId);
    return Object.values(workspace.members).every(
      (member) => member.queue.length === 0 && member.status !== 'running' && !runningMemberIds.has(member.id),
    );
  }

  publicWorkspace(workspace, includeMessages = true) {
    return {
      ...workspace,
      members: Object.fromEntries(Object.entries(workspace.members).map(([id, member]) => [id, {
        ...member,
        messages: includeMessages ? member.messages : [],
      }])),
    };
  }
}

export function searchMemberMessages(member, query, limit = 8) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = member.messages.map((message, index) => {
    const text = String(message.content || '').toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 3 : 0), 0) + index / 10000;
    return { message, score };
  });
  const filtered = tokens.length ? scored.filter((x) => x.score >= 3) : scored.slice(-limit);
  return filtered.sort((a, b) => b.score - a.score).slice(0, limit).map(({ message }) => ({
    id: message.id,
    role: message.role,
    at: message.at,
    content: String(message.content || '').slice(0, 4000),
  }));
}

export function defaultCompilePrompt() {
  return [
    'You are the Result Synthesizer for a multi-context deliberation.',
    'Do not decide by majority vote. Preserve material dissent and uncertainty.',
    'Produce: (1) leading proposal(s), (2) strongest evidence/reasons, (3) strongest alternative,',
    '(4) strongest dissent or failure mode, (5) unresolved uncertainties, (6) next human decision or verification.',
    'Do not claim that another agent statement is evidence merely because another agent said it.'
  ].join(' ');
}
