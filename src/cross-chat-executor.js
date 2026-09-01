export function extractToolCalls(raw) {
  if (!raw || !raw.output) return [];
  return raw.output.filter(x => x.type === 'tool_call' || x.type === 'function_call');
}
export class CrossChatToolExecutor {
  constructor({ store, app }) { this.store = store; this.app = app; }
  async execute(workspaceId, sourceMemberId, toolCalls) {
    const results = [];
    for (const tc of toolCalls) {
      const name = tc.name || tc.function?.name || '';
      const args = tc.args || tc.arguments || tc.function?.arguments || {};
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      if (name === 'list_chats') {
        results.push({ call_id: tc.call_id, output: JSON.stringify({ chats: await this._listChats(workspaceId) }) });
      } else if (name === 'inspect_chat') {
        results.push({ call_id: tc.call_id, output: JSON.stringify({ messages: await this._inspectChat(workspaceId, parsed.target ?? parsed.chat_id, parsed.query, parsed.limit) }) });
      } else if (name === 'send_to_chat') {
        await this.app.sendToChats(workspaceId, sourceMemberId, parsed.targets, parsed.prompt);
        results.push({ call_id: tc.call_id, output: JSON.stringify({ accepted: true }) });
      } else {
        throw new Error(`Unknown cross-chat tool: ${name}`);
      }
    }
    return results;
  }
  async _listChats(workspaceId) {
    const ws = this.store.requireWorkspace(workspaceId);
    return Object.values(ws.members).map(m => ({ id: m.id, name: m.name }));
  }
  async _inspectChat(workspaceId, chatId, query, limit) {
    if (!chatId) throw new Error('target is required for inspect_chat');
    const msgs = await this.app.getChatMessages(workspaceId, chatId, { limit: Math.min(limit || 50, 200) });
    return query ? msgs.filter(m => String(m.content).includes(String(query))) : msgs;
  }
}
