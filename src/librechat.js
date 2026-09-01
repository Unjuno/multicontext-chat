export const REMOTE_AGENTS_MODELS_PATH = "/api/agents/v1/responses/models";

export class LibreChatClient {
  constructor({ baseUrl, apiKey, mode = 'compat', timeoutMs = 900000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.apiKey = apiKey; this.mode = mode; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
  }
  headers() { return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }; }
  assertConfigured() { if (!this.apiKey) throw new Error('LIBRECHAT_API_KEY is not configured'); }

  async listAgents({ signal } = {}) {
    this.assertConfigured();
    // Bound the probe so a wedged LibreChat cannot hang /api/health (and the
    // UI health line) forever; generation requests keep the full timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('LibreChat agents probe timed out')), Math.min(this.timeoutMs, 10_000));
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('Aborted')); signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${REMOTE_AGENTS_MODELS_PATH}`, { headers: this.headers(), signal: controller.signal });
      const text = await response.text(); let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw new Error(data?.error?.message || data?.message || text || `LibreChat HTTP ${response.status}`);
      return Array.isArray(data.data) ? data.data : [];
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relayAbort); }
  }
  async health() {
    const startedAt = Date.now();
    try { const agents = await this.listAgents(); return { ok: true, latencyMs: Date.now() - startedAt, agents: agents.length, mode: this.mode }; }
    catch (error) { return { ok: false, latencyMs: Date.now() - startedAt, error: error.message, mode: this.mode }; }
  }

  async runAgent({ agentId, globalPrompt, developerPrompt, history = [], prompt, conversationId, signal, metadata = {}, toolResults = [] }) {
    if (!agentId) throw new Error('LibreChat agentId is required'); this.assertConfigured();
    const input = [];
    if (globalPrompt?.trim()) input.push({ type: 'message', role: 'system', content: globalPrompt.trim() });
    if (developerPrompt?.trim()) input.push({ type: 'message', role: 'developer', content: developerPrompt.trim() });
    if (this.mode === 'compat') {
      for (const message of history) if (message.role === 'user' || message.role === 'assistant') input.push({ type: 'message', role: message.role, content: String(message.content || '') });
    }
    input.push({ type: 'message', role: 'user', content: String(prompt || '') });
    for (const tr of toolResults) input.push({ type: 'function_call_output', call_id: tr.call_id, output: tr.output });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('LibreChat request timed out')), this.timeoutMs);
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('Aborted')); signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const body = { model: agentId, input, stream: false, store: this.mode === 'native', metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])) };
      if (this.mode === 'native' && conversationId) body.previous_response_id = conversationId;
      if (metadata.workspace_id && metadata.member_id) {
        body.tools = [
          { type: 'function', function: { name: 'list_chats', description: 'List peer chat ids and names in the workspace.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
          { type: 'function', function: { name: 'inspect_chat', description: 'Search selected messages from one peer chat.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'Peer chat UUID or exact name.' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }, required: ['target'], additionalProperties: false } } },
          { type: 'function', function: { name: 'send_to_chat', description: 'Queue the same prompt into one or two peer chats.', parameters: { type: 'object', properties: { targets: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', description: 'Peer chat UUID or exact name.' } }, prompt: { type: 'string', minLength: 1 } }, required: ['targets', 'prompt'], additionalProperties: false } } },
        ];
      }
      const response = await this.fetchImpl(`${this.baseUrl}/api/agents/v1/responses`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      const text = await response.text(); let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw new Error(data?.error?.message || data?.message || text || `LibreChat HTTP ${response.status}`);
      const nextConversationId = response.headers?.get?.('x-librechat-conversation-id') || data.conversation_id || data.metadata?.conversation_id || conversationId || null;
      if (this.mode === 'native' && !nextConversationId) throw new Error('Native LibreChat mode requires the MultiContext LibreChat patch (conversation id header missing)');
      return { id: data.id, text: extractOutputText(data), usage: data.usage ?? null, conversationId: nextConversationId, raw: data };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relayAbort); }
  }
}

export function extractOutputText(response) {
  let out = ''; for (const item of response?.output ?? []) { if (item?.type !== 'message') continue; for (const part of item.content ?? []) if (part?.type === 'output_text' && typeof part.text === 'string') out += part.text; }
  return out.trim();
}
