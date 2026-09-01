import { CROSS_CHAT_TOOLS } from './cross-chat-tools.js';

export function extractToolCalls(raw) {
  if (!raw || !raw.output) return [];
  return raw.output.filter(x => x.type === 'tool_call' || x.type === 'function_call');
}

export { CROSS_CHAT_TOOLS };

export class StructuredToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'StructuredToolError';
  }
}

export class CrossChatToolExecutor {
  constructor({ app }) { this.app = app; }

  async execute(workspaceId, sourceMemberId, queueItemId, toolCallId, toolCalls) {
    const results = [];
    for (const tc of toolCalls) {
      const name = tc.name || tc.function?.name || '';
      const callId = tc.call_id;
      if (!callId) throw new StructuredToolError('MISSING_CALL_ID', `Tool call missing call_id: ${name}`);
      const args = tc.args || tc.arguments || tc.function?.arguments || {};
      const parsed = typeof args === 'string' ? this._parseArgs(args, name, callId) : args;
      if (name === 'list_chats') {
        const chats = await this.app.listPeerChats(workspaceId, sourceMemberId);
        results.push({ call_id: callId, output: JSON.stringify({ chats }) });
      } else if (name === 'inspect_chat') {
        const target = parsed.target ?? parsed.chat_id;
        const query = parsed.query ?? null;
        const limit = this._clampLimit(parsed.limit);
        const result = await this.app.inspectPeerChat(workspaceId, sourceMemberId, target, query, limit);
        results.push({ call_id: callId, output: JSON.stringify(result) });
      } else if (name === 'send_to_chat') {
        const result = await this.app.sendToChats(
          workspaceId, sourceMemberId, parsed.targets, parsed.prompt,
          { sourceQueueItemId: queueItemId, toolCallId: callId }
        );
        results.push({ call_id: callId, output: JSON.stringify(result) });
      } else {
        throw new StructuredToolError('UNKNOWN_TOOL', `Unknown cross-chat tool: ${name}`);
      }
    }
    return results;
  }

  _parseArgs(argsStr, name, callId) {
    try { return JSON.parse(argsStr); }
    catch { throw new StructuredToolError('INVALID_TOOL_ARGUMENTS', `Invalid JSON arguments for ${name} (call_id: ${callId})`); }
  }

  _clampLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1) return 8;
    return Math.min(20, Math.ceil(n));
  }
}