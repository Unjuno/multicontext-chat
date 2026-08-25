import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreChatClient } from '../src/librechat.js';

const response = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers });

test('compat mode replays local history and does not ask LibreChat to store a thread', async () => {
  let captured;
  const client = new LibreChatClient({
    baseUrl: 'http://librechat', apiKey: 'key', mode: 'compat',
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return response({ id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    },
  });
  const result = await client.runAgent({
    agentId: 'agent-a', globalPrompt: 'GLOBAL', developerPrompt: 'AGENT',
    history: [{ role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' }],
    prompt: 'new q', conversationId: 'ignored-in-compat',
  });
  assert.equal(result.text, 'ok');
  assert.equal(captured.store, false);
  assert.equal('previous_response_id' in captured, false);
  assert.deepEqual(captured.input.map((message) => [message.role, message.content]), [
    ['system', 'GLOBAL'], ['developer', 'AGENT'], ['user', 'old q'], ['assistant', 'old a'], ['user', 'new q'],
  ]);
});

test('native mode continues one LibreChat conversation and avoids local history replay', async () => {
  let captured;
  const client = new LibreChatClient({
    baseUrl: 'http://librechat', apiKey: 'key', mode: 'native',
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return response(
        { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'native' }] }] },
        { headers: { 'X-LibreChat-Conversation-Id': 'conversation-1' } },
      );
    },
  });
  const result = await client.runAgent({
    agentId: 'agent-a', globalPrompt: 'GLOBAL', developerPrompt: 'AGENT',
    history: [{ role: 'user', content: 'must not replay' }], prompt: 'next', conversationId: 'conversation-0',
  });
  assert.equal(captured.store, true);
  assert.equal(captured.previous_response_id, 'conversation-0');
  assert.deepEqual(captured.input.map((message) => [message.role, message.content]), [
    ['system', 'GLOBAL'], ['developer', 'AGENT'], ['user', 'next'],
  ]);
  assert.equal(result.conversationId, 'conversation-1');
});

test('native mode fails fast when patched LibreChat does not expose a conversation id', async () => {
  const client = new LibreChatClient({
    baseUrl: 'http://librechat', apiKey: 'key', mode: 'native',
    fetchImpl: async () => response({ id: 'r', output: [] }),
  });
  await assert.rejects(
    client.runAgent({ agentId: 'agent-a', prompt: 'hello' }),
    /requires the MultiContext LibreChat patch/,
  );
});

test('listAgents and health probe the remote Agents API', async () => {
  const urls = [];
  const client = new LibreChatClient({
    baseUrl: 'http://librechat/', apiKey: 'key', mode: 'compat',
    fetchImpl: async (url) => {
      urls.push(url);
      return response({ data: [{ id: 'a' }, { id: 'b' }] });
    },
  });
  assert.deepEqual(await client.listAgents(), [{ id: 'a' }, { id: 'b' }]);
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.agents, 2);
  assert.equal(health.mode, 'compat');
  assert.ok(urls.every((url) => url === 'http://librechat/api/agents/v1/responses/models'));
});

test('health reports connection failures without throwing', async () => {
  const client = new LibreChatClient({
    baseUrl: 'http://librechat', apiKey: 'key', mode: 'compat',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const health = await client.health();
  assert.equal(health.ok, false);
  assert.match(health.error, /offline/);
});
