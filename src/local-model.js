import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXTERNAL_TOOLS } from './cross-chat-tools.js';

// Registration-free loopback Chat Completions adapter. Transcripts are owned
// locally, not by a LibreChat account. The Scheduler still owns all tool effects.
export class LocalModelClient {
  constructor({ baseUrl = 'http://127.0.0.1:8080', directory, timeoutMs = 900000, fetchImpl = fetch }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error('Local model requires an HTTP loopback IP URL');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    this.directory = directory;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.mode = 'native';
    this.provider = 'local';
  }
  async request(route, body, signal) {
    signal?.throwIfAborted();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
    return response.json();
  }
  async listAgents({ signal } = {}) {
    const data = await this.request('models', null, signal);
    return (data.data || []).map(model => ({ ...model, name: model.id, provider: 'local' }));
  }
  async health() {
    try { return { ok: true, agents: (await this.listAgents()).length, mode: this.mode, provider: 'local' }; }
    catch (error) { return { ok: false, error: error.message, provider: 'local' }; }
  }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid local conversation ID');
    return path.join(this.directory, `${id}.json`);
  }
  async read(id, agentId) {
    const record = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    if (record.agentId !== agentId) throw new Error('Local conversation model mismatch');
    return record;
  }
  async generate({ agentId, globalPrompt, developerPrompt, signal, toolPermissions }, messages) {
    const instructions = [];
    if (globalPrompt) instructions.push({ role: 'system', content: globalPrompt });
    if (developerPrompt) instructions.push({ role: 'developer', content: developerPrompt });
    const data = await this.request('chat/completions', {
      model: agentId, messages: [...instructions, ...messages], stream: false,
      tools: EXTERNAL_TOOLS.filter(tool => {
        const name = tool.function.name;
        if (process.env.MULTICONTEXT_SEARCH_ENABLED === 'false' && name === 'search_sources') return false;
        if (!toolPermissions) return true;
        if (name === 'send_to_chat') return toolPermissions.canSendOthers !== false;
        if (name === 'inspect_chat') return toolPermissions.canInspectOthers !== false;
        if (name === 'list_chats') return toolPermissions.canInspectOthers !== false || toolPermissions.canSendOthers !== false;
        return true;
      }),
      tool_choice: 'auto', parallel_tool_calls: false,
    }, signal);
    signal?.throwIfAborted();
    const answer = data.choices?.[0]?.message;
    if (!answer || answer.role !== 'assistant') throw new Error('Invalid local model response');
    const ids = new Set();
    for (const call of answer.tool_calls || []) {
      if (!call.id || ids.has(call.id) || !call.function?.name) throw new Error('Invalid local tool identity');
      ids.add(call.id);
    }
    // Immutable response snapshots: a crash before Scheduler commits the new
    // pointer must leave its old pointer safe for Retry or workspace branching.
    const id = randomUUID();
    const record = { agentId, messages: [...messages, answer], responseId: data.id };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return { id: data.id, conversationId: id, text: answer.content || '', usage: data.usage || null,
      raw: { output: (answer.tool_calls || []).map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })) } };
  }
  async runAgent(args) {
    const messages = args.conversationId ? (await this.read(args.conversationId, args.agentId)).messages
      : (args.history || []).filter(item => ['user', 'assistant'].includes(item.role)).map(({ role, content }) => ({ role, content }));
    if (messages.at(-1)?.tool_calls?.length) throw new Error('Local conversation has unresolved tools');
    return this.generate(args, [...messages, { role: 'user', content: args.prompt }]);
  }
  async continueAgent(args) {
    const record = await this.read(args.conversationId, args.agentId);
    const pending = record.messages.at(-1)?.tool_calls || [];
    const outputs = (args.orderedItems || []).filter(item => item.type === 'function_call_output');
    if (!pending.length || outputs.length !== pending.length || new Set(outputs.map(item => item.call_id)).size !== outputs.length ||
      pending.some(call => !outputs.some(item => item.call_id === call.id))) throw new Error('Local continuation tool outputs do not match pending calls');
    return this.generate(args, [...record.messages,
      ...outputs.map(item => ({ role: 'tool', tool_call_id: item.call_id, content: item.output }))]);
  }
}
