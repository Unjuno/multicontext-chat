export class LibreChatClient {
  constructor({ baseUrl, apiKey, timeoutMs = 900000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async runAgent({ agentId, globalPrompt, developerPrompt, history = [], prompt, signal, metadata = {} }) {
    if (!agentId) throw new Error('LibreChat agentId is required');
    if (!this.apiKey) throw new Error('LIBRECHAT_API_KEY is not configured');

    const input = [];
    if (globalPrompt?.trim()) input.push({ type: 'message', role: 'system', content: globalPrompt.trim() });
    if (developerPrompt?.trim()) input.push({ type: 'message', role: 'developer', content: developerPrompt.trim() });
    for (const message of history) {
      if (message.role === 'user' || message.role === 'assistant') {
        input.push({ type: 'message', role: message.role, content: String(message.content || '') });
      }
    }
    input.push({ type: 'message', role: 'user', content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('LibreChat request timed out')), this.timeoutMs);
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', relayAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/agents/v1/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: agentId,
          input,
          stream: false,
          store: true,
          metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const message = data?.error?.message || data?.message || text || `LibreChat HTTP ${response.status}`;
        throw new Error(message);
      }
      return {
        id: data.id,
        text: extractOutputText(data),
        usage: data.usage ?? null,
        raw: data,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    }
  }
}

export function extractOutputText(response) {
  let out = '';
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') out += part.text;
    }
  }
  return out.trim();
}
