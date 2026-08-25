import test from 'node:test';
import assert from 'node:assert/strict';
import { LibreChatClient, extractOutputText } from '../src/librechat.js';

test('LibreChat request keeps global system and member developer roles distinct at the API boundary', async () => {
  let captured;
  const fakeFetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }), { status: 200 });
  };
  const client = new LibreChatClient({ baseUrl: 'http://librechat', apiKey: 'k', fetchImpl: fakeFetch });
  const result = await client.runAgent({
    agentId: 'agent-a', globalPrompt: 'GLOBAL', developerPrompt: 'AGENT',
    history: [{ role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' }], prompt: 'new q',
  });
  assert.equal(result.text, 'done');
  assert.deepEqual(captured.input.map((m) => [m.role, m.content]), [
    ['system', 'GLOBAL'], ['developer', 'AGENT'], ['user', 'old q'], ['assistant', 'old a'], ['user', 'new q'],
  ]);
});

test('extractOutputText joins assistant output parts', () => {
  assert.equal(extractOutputText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }), 'ab');
});
