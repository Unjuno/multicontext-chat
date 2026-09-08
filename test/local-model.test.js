import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalModelClient } from '../src/local-model.js';

test('local adapter does not advertise unauthorized peer tools', async () => {
  let body;
  const client = new LocalModelClient({ directory: await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-local-perms-')), fetchImpl: async (_, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'r', choices: [{ message: { role: 'assistant', content: 'done' } }] }) };
  } });
  await client.runAgent({ agentId: 'model', prompt: 'independent', toolPermissions: { canInspectOthers: false, canSendOthers: false } });
  const names = body.tools.map(tool => tool.function.name);
  assert.ok(names.includes('search_sources'));
  assert.ok(names.includes('calculate'));
  assert.ok(!names.includes('list_chats'));
  assert.ok(!names.includes('inspect_chat'));
  assert.ok(!names.includes('send_to_chat'));
});

test('local adapter persists tool history across instances without account or key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-local-test-'));
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, json: async () => ({ id: `r${requests.length}`, choices: [{ message: requests.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_chats', arguments: '{}' } }] }
      : { role: 'assistant', content: 'done' } }] }) };
  };
  try {
    const first = await new LocalModelClient({ directory, fetchImpl }).runAgent({ agentId: 'local-model', prompt: 'list peers', developerPrompt: 'role A' });
    const next = new LocalModelClient({ directory, fetchImpl });
    await assert.rejects(next.continueAgent({ agentId: 'other', conversationId: first.conversationId }), /model mismatch/);
    await assert.rejects(next.continueAgent({ agentId: 'local-model', conversationId: first.conversationId, orderedItems: [] }), /do not match/);
    const result = await next.continueAgent({ agentId: 'local-model', conversationId: first.conversationId, developerPrompt: 'role B',
      orderedItems: [{ type: 'function_call_output', call_id: 'c1', output: '{"chats":[]}' }] });
    assert.equal(result.text, 'done');
    assert.notEqual(result.conversationId, first.conversationId);
    assert.equal((await next.read(first.conversationId, 'local-model')).messages.at(-1).tool_calls[0].id, 'c1');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.map(item => item.role), ['developer', 'user', 'assistant', 'tool']);
    assert.equal(requests[1].messages[0].content, 'role B');
    assert.equal(requests[1].messages[3].tool_call_id, 'c1');
  } finally { await fs.rm(directory, { recursive: true }); }
});

test('uncommitted response cannot mutate retry input or a branched conversation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-local-retry-'));
  const requests = [];
  const client = new LocalModelClient({ directory, fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `r${requests.length}`, choices: [{ message: { role: 'assistant', content: 'answer' } }] }) };
  } });
  try {
    const initial = await client.runAgent({ agentId: 'model', prompt: 'original' });
    const before = await fs.readFile(client.file(initial.conversationId), 'utf8');
    // Treat this response as lost before Scheduler stores its returned pointer.
    const lost = await client.runAgent({ agentId: 'model', conversationId: initial.conversationId, prompt: 'retry me' });
    const retried = await client.runAgent({ agentId: 'model', conversationId: initial.conversationId, prompt: 'retry me' });
    assert.deepEqual(requests[1].messages, requests[2].messages);
    assert.notEqual(lost.conversationId, retried.conversationId);
    assert.equal(await fs.readFile(client.file(initial.conversationId), 'utf8'), before);
    await client.runAgent({ agentId: 'model', conversationId: initial.conversationId, prompt: 'separate branch' });
    assert.equal(requests[3].messages.some(message => message.content === 'retry me'), false);
  } finally { await fs.rm(directory, { recursive: true }); }
});

test('local adapter refuses remote or credential-bearing endpoints and path traversal', () => {
  for (const baseUrl of ['http://example.com', 'http://user:pass@127.0.0.1', 'http://localhost:8080']) {
    assert.throws(() => new LocalModelClient({ baseUrl }), /loopback/);
  }
  assert.throws(() => new LocalModelClient({ directory: '/tmp' }).file('../../state'), /conversation ID/);
});
