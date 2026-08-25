export class Scheduler {
  constructor({ store, client, maxHistoryMessages = 120 }) {
    this.store = store; this.client = client; this.maxHistoryMessages = maxHistoryMessages; this.running = new Map();
  }
  key(workspaceId, memberId) { return `${workspaceId}:${memberId}`; }
  runningMemberIds(workspaceId) {
    const prefix = `${workspaceId}:`;
    return new Set([...this.running.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }
  resumeAll() { for (const workspace of Object.values(this.store.state.workspaces)) this.kickWorkspace(workspace.id); }
  kickWorkspace(workspaceId) { const w = this.store.requireWorkspace(workspaceId); for (const m of Object.values(w.members)) this.kickMember(workspaceId, m.id); }
  kickMember(workspaceId, memberId) {
    const key = this.key(workspaceId, memberId); if (this.running.has(key)) return;
    const member = this.store.getMember(workspaceId, memberId); if (!member || !member.active || member.status === 'error' || member.queue.length === 0) return;
    const controller = new AbortController(); this.running.set(key, controller);
    void this.drain(workspaceId, memberId, controller).finally(() => {
      this.running.delete(key);
      const latest = this.store.getMember(workspaceId, memberId);
      if (latest?.active && latest.status !== 'error' && latest.queue.length > 0) this.kickMember(workspaceId, memberId);
    });
  }
  async drain(workspaceId, memberId, controller) {
    while (!controller.signal.aborted) {
      const member = this.store.getMember(workspaceId, memberId); if (!member || !member.active || member.status === 'error' || member.queue.length === 0) break;
      const prepared = this.store.beginNext(workspaceId, memberId); if (!prepared) break;
      const { item, history, conversationId } = prepared;
      try {
        const workspace = this.store.getWorkspace(workspaceId); const current = this.store.getMember(workspaceId, memberId);
        if (!workspace || !current || controller.signal.aborted) break;
        const result = await this.client.runAgent({
          agentId: current.agentId, globalPrompt: workspace.globalPrompt, developerPrompt: current.developerPrompt,
          history: history.slice(-(this.maxHistoryMessages - 1)), prompt: item.prompt, conversationId,
          signal: controller.signal, metadata: { workspace_id: workspaceId, member_id: memberId, queue_item_id: item.id },
        });
        if (controller.signal.aborted || !this.store.getMember(workspaceId, memberId)) continue;
        this.store.completeRun(workspaceId, memberId, item.id, result);
        this.store.trimMessages(workspaceId, memberId, this.maxHistoryMessages);
      } catch (error) {
        if (!this.store.getMember(workspaceId, memberId)) break;
        if (controller.signal.aborted) this.store.failRun(workspaceId, memberId, item.id, 'Stopped by user', { requeue: false });
        else this.store.failRun(workspaceId, memberId, item.id, error?.message || String(error), { requeue: true });
        break;
      }
    }
  }
  stopMember(workspaceId, memberId, { clearQueue = true } = {}) {
    const key = this.key(workspaceId, memberId); this.running.get(key)?.abort(new Error('Stopped by user'));
    this.store.cancelCurrent(workspaceId, memberId, { clearQueue });
  }
  stopWorkspace(workspaceId, { clearQueue = true } = {}) {
    const workspace = this.store.getWorkspace(workspaceId); if (!workspace) return;
    for (const member of Object.values(workspace.members)) this.stopMember(workspaceId, member.id, { clearQueue });
  }
  retryMember(workspaceId, memberId) { this.store.retryMember(workspaceId, memberId); this.kickMember(workspaceId, memberId); }
}
