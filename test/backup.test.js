import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalBackup } from '../src/backup.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { LocalModelClient } from '../src/local-model.js';

test('local backup contains state and tool transcript and refuses active runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-backup-'));
  try {
    const dataFile = path.join(dir, 'local-state.json');
    const scheduler = { running: new Map([['active', {}]]) };
    const store = { save() { fs.writeFileSync(dataFile, '{"state":"current"}'); } };
    assert.throws(() => createLocalBackup({ dataFile, scheduler, store }), /実行完了/);
    assert.equal(fs.existsSync(dataFile), false);
    scheduler.running.clear();
    fs.mkdirSync(`${dataFile}.local-conversations`);
    const name = '12345678-1234-1234-1234-123456789abc.json';
    fs.writeFileSync(path.join(`${dataFile}.local-conversations`, name), '{"messages":["tool result"]}');
    const result = createLocalBackup({ dataFile, scheduler, store });
    assert.equal(result.files, 2);
    assert.equal(fs.readFileSync(path.join(result.path, 'state.json'), 'utf8'), '{"state":"current"}');
    assert.match(fs.readFileSync(path.join(result.path, 'conversations', name), 'utf8'), /tool result/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'))).backend, 'local');
    fs.symlinkSync(dataFile, path.join(`${dataFile}.local-conversations`, 'aaaaaaaa-1234-1234-1234-123456789abc.json'));
    assert.throws(() => createLocalBackup({ dataFile, scheduler, store }), /non-regular/);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(name => !name.endsWith('.partial')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('backup HTTP route requires REST authorization and reports busy state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-backup-http-'));
  const runtime = createApp({ config: { ...config, dataFile: path.join(dir, 'state.json'), backend: 'local', appToken: 'test-only', mcpEnabled: false },
    client: { health: async () => ({ ok: true }) } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${runtime.server.address().port}/api/backup`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
    runtime.scheduler.running.set('busy', {});
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test-only' } })).status, 409);
    runtime.scheduler.running.clear();
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test-only' } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(fs.existsSync(path.join(result.path, 'manifest.json')));
  } finally {
    runtime.server.closeAllConnections();
    await new Promise(resolve => runtime.server.close(resolve));
    fs.rmSync(dir, { recursive: true });
  }
});

test('restored backup resumes pending tools without losing assistant call identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-backup-restore-'));
  try {
    const dataFile = path.join(dir, 'original.json');
    const client = new LocalModelClient({ directory: `${dataFile}.local-conversations`, fetchImpl: async () => ({ ok: true,
      json: async () => ({ id: 'original-response', choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'pending-search', type: 'function', function: { name: 'search_sources', arguments: '{"query":"test"}' } }] } }] }) }) });
    const initial = await client.runAgent({ agentId: 'test-model', prompt: 'test prompt' });
    const snapshot = createLocalBackup({ dataFile, scheduler: { running: new Map() },
      store: { save: () => fs.writeFileSync(dataFile, JSON.stringify({ conversationId: initial.conversationId })) } });
    const restoredState = path.join(dir, 'restored.json');
    fs.copyFileSync(path.join(snapshot.path, 'state.json'), restoredState);
    fs.cpSync(path.join(snapshot.path, 'conversations'), `${restoredState}.local-conversations`, { recursive: true });
    const state = JSON.parse(fs.readFileSync(restoredState));
    let sent;
    const restored = new LocalModelClient({ directory: `${restoredState}.local-conversations`, fetchImpl: async (_, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: 'continued', choices: [{ message: { role: 'assistant', content: 'restored' } }] }) };
    } });
    const final = await restored.continueAgent({ agentId: 'test-model', conversationId: state.conversationId,
      orderedItems: [{ type: 'function_call_output', call_id: 'pending-search', output: 'actual preserved test result' }] });
    assert.equal(final.text, 'restored');
    assert.deepEqual(sent.messages.map(message => message.role), ['user', 'assistant', 'tool']);
    assert.equal(sent.messages[1].tool_calls[0].id, sent.messages[2].tool_call_id);
    assert.equal(sent.messages[2].content, 'actual preserved test result');
    assert.equal((await client.read(initial.conversationId, 'test-model')).responseId, 'original-response', 'restoration must not mutate original');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
