import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreChatClient } from '../src/librechat.js';

for (const [mode, method, extra] of [
  ['native', 'listAgents', {}],
  ['native', 'runAgentInitial', {}],
  ['native', 'continueAgent', { conversationId: 'previous' }],
  ['native', 'runAgent', {}],
  ['native', 'runAgent', { conversationId: 'previous', toolResults: [{ call_id: 'c1', output: 'done' }] }],
  ['compat', 'runAgent', {}],
]) {
  test(`pre-cancelled ${mode} ${method} ${extra.toolResults ? 'continuation' : ''} sends no request`, async () => {
    let requests = 0;
    const client = new LibreChatClient({ baseUrl: 'http://librechat', apiKey: 'test', mode,
      fetchImpl: async () => {
        requests++;
        return new Response(JSON.stringify({ data: [], conversation_id: 'next', output: [] }));
      } });
    const reason = new Error('user stopped this run before dispatch');
    await assert.rejects(client[method]({ agentId: 'agent', prompt: 'test', ...extra,
      signal: AbortSignal.abort(reason) }), error => error === reason);
    assert.equal(requests, 0);
  });
  test(`in-flight ${mode} ${method} ${extra.toolResults ? 'continuation' : ''} propagates cancellation`, async () => {
    const controller = new AbortController();
    const reason = new Error('user stopped during dispatch');
    let requests = 0;
    const client = new LibreChatClient({ baseUrl: 'http://librechat', apiKey: 'test', mode,
      fetchImpl: async (_url, init) => {
        requests++;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          queueMicrotask(() => controller.abort(reason));
        });
      } });
    await assert.rejects(client[method]({ agentId: 'agent', prompt: 'test', ...extra,
      signal: controller.signal }), error => error === reason);
    assert.equal(requests, 1);
  });
}
