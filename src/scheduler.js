export class Scheduler {
  constructor({ store, client, maxHistoryMessages = 120 }) {
    this.store = store;
    this.client = client;
    this.maxHistoryMessages = maxHistoryMessages;
    this.running = new Map();
  }

  key(workspaceId, memberId) { return `${workspaceId}:${memberId}`; }

  runningMemberIds(workspaceId) {
    const prefix = `${workspaceId}:`;
    return new Set([...this.running.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }

  kickWorkspace(workspaceId) {
    const workspace = this.store.requireWorkspace(workspaceId);
    for (const member of Object.values(workspace.members)) this.kickMember(workspaceId, member.id);
  }

  kickMember(workspaceId, memberId) {
    const key = this.key(workspaceId, memberId);
    if (this.running.has(key)) return;
    const { member } = this.store.requireMember(workspaceId, memberId);
    if (!member.active || member.queue.length === 0) return;
    const controller = new AbortController();
    this.running.set(key, controller);
    void this.drain(workspaceId, memberId, controller).finally(() => {
      this.running.delete(key);
      const { member: latest } = this.store.requireMember(workspaceId, memberId);
      if (latest.status === 'running') this.store.setMemberRuntime(workspaceId, memberId, { status: 'idle' });
      if (latest.queue.length > 0 && latest.active) this.kickMember(workspaceId, memberId);
    });
  }

  async drain(workspaceId, memberId, controller) {
    while (!controller.signal.aborted) {
      const { workspace, member } = this.store.requireMember(workspaceId, memberId);
      if (!member.active || member.queue.length === 0) break;
      const item = this.store.shiftQueue(workspaceId, memberId);
      if (!item) break;

      const history = member.messages.slice(-(this.maxHistoryMessages - 1));
      this.store.setMemberRuntime(workspaceId, memberId, {
        status: 'running',
        lastError: null,
        lastRun: { queueItemId: item.id, prompt: item.prompt, startedAt: new Date().toISOString() },
      });
      this.store.appendMessage(workspaceId, memberId, {
        role: 'user', content: item.prompt, source: item.source, sourceMemberId: item.sourceMemberId,
      });

      try {
        const result = await this.client.runAgent({
          agentId: member.agentId,
          globalPrompt: workspace.globalPrompt,
          developerPrompt: member.developerPrompt,
          history,
          prompt: item.prompt,
          signal: controller.signal,
          metadata: { workspace_id: workspaceId, member_id: memberId, queue_item_id: item.id },
        });
        this.store.appendMessage(workspaceId, memberId, {
          role: 'assistant', content: result.text, responseId: result.id, usage: result.usage,
        });
        this.store.trimMessages(workspaceId, memberId, this.maxHistoryMessages);
        workspace.stats.executions += 1;
        this.store.setMemberRuntime(workspaceId, memberId, {
          status: 'idle',
          lastRun: { ...member.lastRun, finishedAt: new Date().toISOString(), responseId: result.id },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          this.store.setMemberRuntime(workspaceId, memberId, { status: 'idle', lastError: 'Stopped by user' });
          break;
        }
        this.store.setMemberRuntime(workspaceId, memberId, { status: 'error', lastError: error.message });
        break;
      }
    }
  }

  stopWorkspace(workspaceId, { clearQueue = true } = {}) {
    const prefix = `${workspaceId}:`;
    for (const [key, controller] of this.running) {
      if (key.startsWith(prefix)) controller.abort(new Error('Stopped by user'));
    }
    if (clearQueue) this.store.clearQueues(workspaceId);
    const workspace = this.store.requireWorkspace(workspaceId);
    for (const member of Object.values(workspace.members)) {
      this.store.setMemberRuntime(workspaceId, member.id, { status: 'idle' });
    }
  }
}
