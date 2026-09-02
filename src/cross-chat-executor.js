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

  async execute({ workspaceId, sourceMemberId, sourceQueueItemId, toolCalls, signal } = {}) {
    if (signal?.aborted) throw new StructuredToolError('ABORTED', 'Aborted before tool execution');
    const results = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) throw new StructuredToolError('ABORTED', 'Aborted during tool execution');
      const name = tc.name || tc.function?.name || '';
      const callId = tc.call_id;
      if (!callId) throw new StructuredToolError('MISSING_CALL_ID', `Tool call missing call_id: ${name}`);
      const args = tc.args || tc.arguments || tc.function?.arguments || {};
      let parsed;
      try {
        parsed = typeof args === 'string' ? this._parseArgs(args, name, callId) : args;
      } catch (e) {
        if (e instanceof StructuredToolError) {
          results.push({ call_id: callId, output: JSON.stringify({ ok: false, error: { code: e.code, message: e.message } }) });
          continue;
        }
        throw e;
      }
      try {
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
            { sourceQueueItemId, toolCallId: callId }
          );
          results.push({ call_id: callId, output: JSON.stringify(result) });
        } else {
          throw new StructuredToolError('UNKNOWN_TOOL', `Unknown cross-chat tool: ${name}`);
        }
      } catch (e) {
        // Model-correctable errors -> structured output, not BLOCK
        if (e && (e.code === 'INVALID_TOOL_ARGUMENTS' || e.code === 'UNKNOWN_TOOL' || e.status === 400 || e.status === 403 || e.status === 404 || e.status === 409)) {
          const code = e.code || (e.status === 403 ? 'PERMISSION_DENIED' : e.status === 404 ? 'NOT_FOUND' : e.status === 409 ? 'CONFLICT' : 'TOOL_ERROR');
          results.push({ call_id: callId, output: JSON.stringify({ ok: false, error: { code, message: e.message } }) });
          continue;
        }
        // Infrastructure failures remain real failures
        throw e;
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