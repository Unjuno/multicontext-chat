import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-disc-')), 'state.json'));
const makeConfig = () => ({
  dataFile: '/unused', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://x', librechatApiKey: 'k', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  mcpToken: '', mcpEnabled: true, host: '127.0.0.1', port: 4317,
});

const runOk = async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` });

test('successful zero agent response => AGENT_SELECTION_REQUIRED', async () => {
  const client = { listAgents: async () => [], health: async () => ({ ok: true }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client, scheduler: new Scheduler({ store, client }) });
  const ws = await app.createWorkspace({ name: 'Zero' });
  await app.addChat(ws.id, { name: 'A' });
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => {
    assert.equal(e.code, 'AGENT_SELECTION_REQUIRED');
    assert.ok(e.message.includes('Agent') || e.message.includes('ありません'));
    return true;
  });
  // No mutation
  assert.equal(store.requireWorkspace(ws.id).members[Object.keys(store.requireWorkspace(ws.id).members)[0]].queue.length, 0);
});

test('discovery failure with no cache => DISCOVERY_FAILED not zero Agents', async () => {
  const client = { listAgents: async () => { throw new Error('fetch failed: Connection refused'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client, scheduler: new Scheduler({ store, client }) });
  const ws = await app.createWorkspace({ name: 'FailNoCache' });
  await app.addChat(ws.id, { name: 'A' });
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => {
    assert.equal(e.code, 'DISCOVERY_FAILED');
    assert.ok(e.message.includes('取得に失敗'));
    return true;
  });
  assert.equal(store.requireWorkspace(ws.id).members[Object.keys(store.requireWorkspace(ws.id).members)[0]].queue.length, 0);
  // Direct also
  const mid = Object.keys(store.requireWorkspace(ws.id).members)[0];
  await assert.rejects(() => app.send(ws.id, mid, 'hi'), (e) => e.code === 'DISCOVERY_FAILED');
  assert.equal(store.requireWorkspace(ws.id).members[mid].queue.length, 0);
});

test('auth failure distinguishable if client throws auth message', async () => {
  const client = { listAgents: async () => { throw Object.assign(new Error('Invalid API key'), { status: 401 }); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client, scheduler: new Scheduler({ store, client }) });
  const ws = await app.createWorkspace({ name: 'AuthFail' });
  await app.addChat(ws.id, { name: 'A' });
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => {
    assert.equal(e.code, 'DISCOVERY_FAILED');
    assert.ok(e.message.includes('Invalid API key') || e.message.includes('取得に失敗'));
    return true;
  });
});

test('cached list + new discovery failure => execution validates fresh not cached', async () => {
  const agents = [{ id: 'a1', name: 'A' }];
  let failNext = false;
  const client = {
    listAgents: async () => {
      if (failNext) throw new Error('network timeout');
      return agents;
    },
    health: async () => ({ ok: true }),
    runAgent: runOk,
  };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client });
  const app = createApplication({ config: makeConfig(), store, client, scheduler });
  // Prime cache with successful discovery
  const ws = await app.createWorkspace({ name: 'Cached', defaultAgentId: 'a1' });
  await app.addChat(ws.id, { name: 'M', agentId: 'a1' });
  // Cached agents now a1
  failNext = true;
  // Clear app cache by creating new app instance sharing same store but fresh discovery failure
  const app2 = createApplication({ config: makeConfig(), store, client, scheduler });
  // Need to prime app2 cache? Actually app2 has empty cache, but client now fails. broadcast should fail with DISCOVERY_FAILED, not use cached from app.
  // But app already has cached a1 from previous successful call; we test that execution must not silently claim cached is confirmed current.
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => e.code === 'DISCOVERY_FAILED');
  // No mutation
  assert.equal(store.requireWorkspace(ws.id).members[Object.keys(store.requireWorkspace(ws.id).members)[0]].queue.length, 0);
});

test('stale ID + discovery failure => DISCOVERY_FAILED not AGENT_NOT_AVAILABLE', async () => {
  const clientGood = { listAgents: async () => [{ id: 'a1' }], health: async () => ({ ok: true }), runAgent: runOk };
  const store = makeStore();
  const appGood = createApplication({ config: makeConfig(), store, client: clientGood, scheduler: new Scheduler({ store, client: clientGood }) });
  const ws = await appGood.createWorkspace({ name: 'StaleDisc', defaultAgentId: 'a1' });
  await appGood.addChat(ws.id, { name: 'M', agentId: 'a1' });
  // Now discovery fails
  const clientFail = { listAgents: async () => { throw new Error('LibreChat unreachable'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const appFail = createApplication({ config: makeConfig(), store, client: clientFail, scheduler: new Scheduler({ store, client: clientFail }) });
  await assert.rejects(() => appFail.broadcast(ws.id, 'hi'), (e) => {
    assert.equal(e.code, 'DISCOVERY_FAILED');
    return true;
  });
  // Should not have mutated
  assert.equal(store.requireWorkspace(ws.id).members[Object.keys(store.requireWorkspace(ws.id).members)[0]].queue.length, 0);
});

test('Broadcast no mutation on discovery error', async () => {
  const clientFail = { listAgents: async () => { throw new Error('fetch failed'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler: new Scheduler({ store, client: clientFail }) });
  const ws = await app.createWorkspace({ name: 'NoMutBC' });
  await app.addChat(ws.id, { name: 'A' });
  await app.addChat(ws.id, { name: 'B' });
  const beforeA = store.requireWorkspace(ws.id).members[Object.keys(store.requireWorkspace(ws.id).members)[0]].queue.length;
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => e.code === 'DISCOVERY_FAILED');
  const after = store.requireWorkspace(ws.id);
  for (const m of Object.values(after.members)) assert.equal(m.queue.length, beforeA);
});

test('Direct no mutation on discovery error', async () => {
  const clientFail = { listAgents: async () => { throw new Error('fetch failed'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler: new Scheduler({ store, client: clientFail }) });
  const ws = await app.createWorkspace({ name: 'NoMutDirect' });
  const { member } = await app.addChat(ws.id, { name: 'M' });
  await assert.rejects(() => app.send(ws.id, member.id, 'hi'), (e) => e.code === 'DISCOVERY_FAILED');
  assert.equal(store.requireWorkspace(ws.id).members[member.id].queue.length, 0);
});

test('cross-chat no partial delivery on discovery error', async () => {
  const clientFail = { listAgents: async () => { throw new Error('fetch failed'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client: clientFail });
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler });
  // Need to create workspace with valid agents first, then switch to failing client for sendToChats
  const clientGood = { listAgents: async () => [{ id: 'a1' }, { id: 'a2' }], health: async () => ({ ok: true }), runAgent: runOk };
  const appGood = createApplication({ config: makeConfig(), store, client: clientGood, scheduler });
  const ws = await appGood.createWorkspace({ name: 'CrossDisc' });
  const mA = (await appGood.addChat(ws.id, { name: 'A', agentId: 'a1' })).member;
  const mB = (await appGood.addChat(ws.id, { name: 'B', agentId: 'a2' })).member;
  const mC = (await appGood.addChat(ws.id, { name: 'C', agentId: 'a1' })).member;
  // Now attempt cross-chat with failing discovery
  await assert.rejects(() => app.sendToChats(ws.id, mA.id, [mB.id, mC.id], 'hello'), (e) => e.code === 'DISCOVERY_FAILED');
  const after = store.requireWorkspace(ws.id);
  assert.equal(after.members[mB.id].queue.length, 0);
  assert.equal(after.members[mC.id].queue.length, 0);
});

test('Compile no execution on discovery error', async () => {
  const clientFail = { listAgents: async () => { throw new Error('fetch failed'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client: clientFail });
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler });
  const ws = await app.createWorkspace({ name: 'CompileDisc' });
  await app.addChat(ws.id, { name: 'M' });
  await assert.rejects(() => app.compile(ws.id), (e) => e.code === 'DISCOVERY_FAILED');
  assert.equal(store.requireWorkspace(ws.id).lastCompile, null);
});

test('createWorkspace discovery failure does not persist unverified supplied Agent', async () => {
  const clientFail = { listAgents: async () => { throw new Error('LibreChat unreachable'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler: new Scheduler({ store, client: clientFail }) });
  const beforeCount = Object.keys(store.state.workspaces).length;
  await assert.rejects(() => app.createWorkspace({ name: 'BadCreate', defaultAgentId: 'a1' }), (e) => e.code === 'DISCOVERY_FAILED');
  assert.equal(Object.keys(store.state.workspaces).length, beforeCount);
});

test('createWorkspace blank ID remains allowed even when discovery fails later', async () => {
  const clientFail = { listAgents: async () => { throw new Error('fail'); }, health: async () => ({ ok: false }), runAgent: runOk };
  const store = makeStore();
  const app = createApplication({ config: makeConfig(), store, client: clientFail, scheduler: new Scheduler({ store, client: clientFail }) });
  // Blank ID should not trigger discovery validation, so create should succeed
  const ws = await app.createWorkspace({ name: 'BlankAllowed' });
  assert.ok(ws.id);
  assert.equal(ws.defaultAgentId, '');
  // But broadcast should then fail with DISCOVERY_FAILED
  await app.addChat(ws.id, { name: 'M' });
  await assert.rejects(() => app.broadcast(ws.id, 'hi'), (e) => e.code === 'DISCOVERY_FAILED');
});

test('scheduler preserves queued prompt on discovery outage and Retry resumes FIFO', async () => {
  const singleAgent = [{ id: 'solo', name: 'Solo' }];
  let failDiscovery = false;
  let runCount = 0;
  const seen = [];
  const client = {
    listAgents: async () => {
      if (failDiscovery) throw new Error('LibreChat unreachable');
      return singleAgent;
    },
    health: async () => ({ ok: !failDiscovery }),
    runAgent: async ({ prompt }) => {
      runCount++;
      seen.push(prompt);
      return { id: `r${runCount}`, text: `ok:${prompt}` };
    },
  };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  const app = createApplication({ config: makeConfig(), store, client, scheduler });
  const ws = await app.createWorkspace({ name: 'QueuePreserve' });
  const { member } = await app.addChat(ws.id, { name: 'M' });
  // Enqueue directly via store to avoid app validation racing with discovery toggle
  store.enqueue(ws.id, member.id, 'first');
  store.enqueue(ws.id, member.id, 'second');
  const before = store.requireMember(ws.id, member.id).member;
  assert.equal(before.queue.length, 2);
  const firstId = before.queue[0].id;
  // Make discovery fail before scheduler executes
  failDiscovery = true;
  // Scheduler will attempt to drain; it should fail with DISCOVERY_FAILED and requeue at front BLOCKED
  scheduler.kickMember(ws.id, member.id);
  // Wait for BLOCKED
  let attempts = 0;
  while (attempts++ < 100) {
    const cur = store.requireMember(ws.id, member.id).member;
    if (cur.status === 'error') break;
    await new Promise(r => setTimeout(r, 10));
  }
  const blocked = store.requireMember(ws.id, member.id).member;
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.queue[0].id, firstId, 'item ID retained');
  assert.deepEqual(blocked.queue.map(i => i.prompt), ['first', 'second']);
  assert.equal(seen.length, 0, 'no run should have succeeded during outage');
  // Restore and Retry should resume FIFO without duplicate
  failDiscovery = false;
  scheduler.retryMember(ws.id, member.id);
  attempts = 0;
  while (store.requireMember(ws.id, member.id).member.queue.length > 0 || store.requireMember(ws.id, member.id).member.status === 'running') {
    await new Promise(r => setTimeout(r, 10));
    if (++attempts > 200) break;
  }
  assert.deepEqual(seen, ['first', 'second']);
  const msgs = store.requireMember(ws.id, member.id).member.messages.filter(m => m.role === 'assistant').map(m => m.content);
  assert.deepEqual(msgs, ['ok:first', 'ok:second']);
});
