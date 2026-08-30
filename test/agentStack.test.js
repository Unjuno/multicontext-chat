import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-agent-')), 'state.json'));
const makeConfig = (overrides = {}) => ({
  dataFile: '/unused/state.json', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://librechat', librechatApiKey: 'key', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  ...overrides,
});
async function withServer(client, fn, configOverrides = {}) {
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const app = createApp({ config: makeConfig(configOverrides), store, client, scheduler });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try { await fn({ store, scheduler, app, base }); }
  finally { await new Promise((r) => app.server.close(r)); }
}
async function jfetch(base, route, opts = {}) {
  const res = await fetch(`${base}${route}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = res.status === 204 ? null : await res.json();
  return { res, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load DesktopUI for aggregate/runtime polling tests
const code = readFileSync(fileURLToPath(new URL('../public/desktop-ui.js', import.meta.url)), 'utf8');
const sandbox = { exports: {} };
new Function('module','exports','self','window', code)(sandbox, sandbox.exports, undefined, undefined);
const UI = sandbox.exports;
function status(name, state, extra={}){ return {name, state, message:'', ownership:null, ...extra}; }

// 1
test('one discovered Agent → automatically selected as workspace default', async () => {
  const client = { listAgents: async () => [{ id: 'agent-1', name: 'GPT-OSS Default' }], health: async () => ({ ok:true, agents:1, mode:'compat' }), runAgent: async () => ({ id:'r', text:'ok'}) };
  await withServer(client, async ({ base }) => {
    const { data } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W' }) });
    assert.equal(data.defaultAgentId, 'agent-1');
  });
});
// 2
test('explicit member Agent overrides workspace default', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name:'W', defaultAgentId:'ws-default' });
  const m = store.addMember(ws.id, { name:'M', agentId:'member-specific' });
  assert.equal(store.effectiveAgentId(ws.id, m.id), 'member-specific');
});
// 3
test('workspace default applies to members without override', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name:'W', defaultAgentId:'ws-default' });
  const m = store.addMember(ws.id, { name:'M' });
  assert.equal(store.effectiveAgentId(ws.id, m.id), 'ws-default');
});
// 4
test('legacy member without Agent becomes usable through fallback (scheduler resolves)', async () => {
  const client = {
    listAgents: async () => [{ id:'auto-1', name:'Auto' }],
    runAgent: async ({ agentId }) => ({ id:'r', text:`ok:${agentId}` }),
    health: async () => ({ ok:true, agents:1, mode:'compat' }),
  };
  await withServer(client, async ({ base, store }) => {
    const { data: ws } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W' }) });
    // Add legacy member with no agent (force via direct store bypass of auto-default by clearing after creation)
    // First create with auto default, then clear to simulate legacy
    const add = await jfetch(base, `/api/workspaces/${ws.id}/members`, { method:'POST', body: JSON.stringify({ name:'Legacy' }) });
    const mid = add.data.member.id;
    // Manually clear both member and workspace defaults to simulate legacy unpersisted state
    store.updateMember(ws.id, mid, { agentId: '' });
    store.updateWorkspace(ws.id, { defaultAgentId: '' });
    // Now enqueue should trigger fallback discovery and succeed
    const before = (await jfetch(base, `/api/workspaces/${ws.id}`)).data.members[mid];
    assert.equal(before.agentId, '');
    // Broadcast should auto-resolve and succeed (not 400)
    const bc = await jfetch(base, `/api/workspaces/${ws.id}/broadcast`, { method:'POST', body: JSON.stringify({ prompt:'hello legacy' }) });
    assert.equal(bc.res.status, 202);
    // Scheduler should complete without BLOCKED
    await sleep(120);
    const after = (await jfetch(base, `/api/workspaces/${ws.id}`)).data;
    assert.equal(after.runtimeState !== 'BLOCKED', true);
    // effective should now be auto-1 via persisted default
    const finalWs = store.getWorkspace(ws.id);
    assert.ok(finalWs.defaultAgentId === 'auto-1' || after.members[mid].agentId === 'auto-1' || finalWs.defaultAgentId.length>0);
  });
});
// 5
test('no available Agent → Broadcast rejected before queue mutation', async () => {
  const client = { listAgents: async () => [], health: async () => ({ ok:true, agents:0, mode:'compat' }), runAgent: async () => ({ id:'r', text:'ok'}) };
  await withServer(client, async ({ base, store }) => {
    const { data: ws } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W' }) });
    // Clear default to simulate zero agents scenario (server would have not set default)
    store.updateWorkspace(ws.id, { defaultAgentId: '' });
    const a = store.addMember(ws.id, { name:'A' });
    const b = store.addMember(ws.id, { name:'B' });
    // ensure no default
    store.updateWorkspace(ws.id, { defaultAgentId: '' });
    store.updateMember(ws.id, a.id, { agentId: '' });
    store.updateMember(ws.id, b.id, { agentId: '' });
    // Broadcast should be rejected 400
    const bc = await jfetch(base, `/api/workspaces/${ws.id}/broadcast`, { method:'POST', body: JSON.stringify({ prompt:'hello' }) });
    assert.equal(bc.res.status, 400);
    assert.match(bc.data.error, /利用可能なLibreChat Agent/);
    // queues must remain empty (no mutation)
    assert.equal(store.getMember(ws.id, a.id).queue.length, 0);
    assert.equal(store.getMember(ws.id, b.id).queue.length, 0);
  });
});
// 6
test('no available Agent → members do NOT become BLOCKED', async () => {
  const client = {
    listAgents: async () => [],
    health: async () => ({ ok:true, agents:0, mode:'compat' }),
    runAgent: async () => { throw new Error('should not be called'); },
  };
  await withServer(client, async ({ base, store }) => {
    const { data: ws } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W' }) });
    store.updateWorkspace(ws.id, { defaultAgentId: '' });
    const m = store.addMember(ws.id, { name:'M', agentId:'' });
    store.updateMember(ws.id, m.id, { agentId: '' });
    // Direct enqueue should be rejected 400, not queued
    const enq = await jfetch(base, `/api/workspaces/${ws.id}/members/${m.id}/enqueue`, { method:'POST', body: JSON.stringify({ prompt:'hi' }) });
    assert.equal(enq.res.status, 400);
    const mem = store.getMember(ws.id, m.id);
    assert.notEqual(mem.status, 'error');
    assert.equal(mem.status, 'idle');
  });
});
// 7
test('Direct validates effective Agent', async () => {
  const client = { listAgents: async () => [{ id:'good', name:'Good'}], health: async()=>({ok:true, agents:1, mode:'compat'}), runAgent: async()=>({id:'r', text:'ok'}) };
  await withServer(client, async ({ base, store }) => {
    const { data: ws } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W', defaultAgentId:'good' }) });
    const m = store.addMember(ws.id, { name:'M' }); // inherits default
    const ok = await jfetch(base, `/api/workspaces/${ws.id}/members/${m.id}/enqueue`, { method:'POST', body: JSON.stringify({ prompt:'hi' }) });
    assert.equal(ok.res.status, 202);
    // Now test with no effective agent but available agent → should auto-resolve and succeed
    store.updateWorkspace(ws.id, { defaultAgentId: '' });
    store.updateMember(ws.id, m.id, { agentId: '' });
    // Clear queues for second attempt
    store.clearQueues(ws.id);
    const fallback = await jfetch(base, `/api/workspaces/${ws.id}/members/${m.id}/enqueue`, { method:'POST', body: JSON.stringify({ prompt:'hi2' }) });
    // With fallback discovery, it should succeed (202) because listAgents has 'good'
    assert.equal(fallback.res.status, 202);
  });
});
// 8
test('explicit Agent IDs are preserved after workspace default changes', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name:'W', defaultAgentId:'default-1' });
  const m = store.addMember(ws.id, { name:'M', agentId:'explicit-1' });
  store.updateWorkspace(ws.id, { defaultAgentId: 'default-2' });
  assert.equal(store.getMember(ws.id, m.id).agentId, 'explicit-1');
  assert.equal(store.effectiveAgentId(ws.id, m.id), 'explicit-1');
});
// 9
test('Agent discovery failure produces actionable state', async () => {
  const client = { listAgents: async () => { throw new Error('fetch failed'); }, health: async()=>({ok:false, agents:0, mode:'compat'}), runAgent: async()=>({id:'r', text:'ok'}) };
  await withServer(client, async ({ base }) => {
    const health = await jfetch(base, '/api/health');
    assert.equal(health.res.status, 503);
    // Broadcast with no agents and failing discovery should be 400 with Japanese message
    const { data: ws } = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W2' }) });
    // workspace default will be empty because discovery failed
    assert.equal(ws.defaultAgentId, '');
    const add = await jfetch(base, `/api/workspaces/${ws.id}/members`, { method:'POST', body: JSON.stringify({ name:'M' }) });
    const mid = add.data.member.id;
    const bc = await jfetch(base, `/api/workspaces/${ws.id}/broadcast`, { method:'POST', body: JSON.stringify({ prompt:'hi' }) });
    assert.equal(bc.res.status, 400);
    assert.match(bc.data.error, /利用可能なLibreChat Agent/);
  });
});
// 10
test('AI Stack aggregate READY when all prerequisites pass', () => {
  const statuses = [
    status('モデル','ready'), status('LibreChat','ready'), status('MultiContext','ready'), status('LibreChat Agent','ready')
  ];
  const agg = UI.aggregateStatus(statuses);
  assert.equal(agg.cls, 'ready');
  assert.equal(agg.text, 'AI Stack ● 準備完了');
});
// 11
test('Agent missing makes aggregate 要確認 while GPT-OSS remains READY', () => {
  const statuses = [
    status('モデル','ready'), status('LibreChat','ready'), status('MultiContext','ready'), status('LibreChat Agent','error', { message:'未設定' })
  ];
  const agg = UI.aggregateStatus(statuses);
  assert.equal(agg.cls, 'error');
  assert.equal(agg.text, 'AI Stack ● 要確認');
  // individual GPT-OSS remains ready
  const gpt = UI.serviceDisplayLabel('モデル','ready');
  assert.equal(gpt, '準備完了');
  const agentLabel = UI.serviceDisplayLabel('LibreChat Agent','error');
  assert.equal(agentLabel, '未設定');
});
// 12
test('status polling converges from checking to ready', () => {
  // Simulate sequence: all checking -> one ready -> all ready
  let statuses = {};
  statuses = UI.applyStartupEvent(statuses, status('モデル','checking',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('LibreChat','checking',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('MultiContext','checking',{attempt_id:1}), 1);
  assert.equal(UI.aggregateStatus(Object.values(statuses)).cls, 'starting');
  statuses = UI.applyStartupEvent(statuses, status('モデル','ready',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('LibreChat','ready',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('MultiContext','ready',{attempt_id:1}), 1);
  assert.equal(UI.aggregateStatus(Object.values(statuses)).cls, 'ready');
  assert.equal(UI.shouldNavigate(Object.values(statuses), false), true);
});
// 13
test('status polling failure does not permanently stick at checking', () => {
  let statuses = {};
  statuses = UI.applyStartupEvent(statuses, status('モデル','checking',{attempt_id:1}), 1);
  // Simulate a failed poll: no new events arrive, but aggregate should not be ready and next poll should retry
  // Our UI treats pure checking as starting, but a persistent error should become 要確認 after fallback
  const aggChecking = UI.aggregateStatus(Object.values(statuses));
  assert.equal(aggChecking.cls, 'starting');
  // Simulate fallback error synthesis after failure: error entry for MultiContext
  statuses = UI.applyStartupEvent(statuses, status('MultiContext','error',{attempt_id:1}), 1);
  const aggError = UI.aggregateStatus(Object.values(statuses));
  assert.equal(aggError.cls, 'error');
  assert.equal(aggError.text, 'AI Stack ● 要確認');
  // Now success on retry should converge to ready
  statuses = UI.applyStartupEvent(statuses, status('LibreChat','ready',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('MultiContext','ready',{attempt_id:1}), 1);
  statuses = UI.applyStartupEvent(statuses, status('モデル','ready',{attempt_id:1}), 1);
  assert.equal(UI.aggregateStatus(Object.values(statuses)).cls, 'ready');
});
// 14
test('startup old-attempt events cannot be relabeled with a new attempt ID', () => {
  let s1 = {};
  s1 = UI.applyStartupEvent(s1, status('モデル','ready',{attempt_id:1}), 1);
  s1 = UI.applyStartupEvent(s1, status('LibreChat','ready',{attempt_id:1}), 1);
  s1 = UI.applyStartupEvent(s1, status('MultiContext','ready',{attempt_id:1}), 1);
  assert.equal(UI.shouldNavigate(Object.values(s1), false), true);
  let s2 = {};
  s2 = UI.applyStartupEvent(s2, status('モデル','ready',{attempt_id:2}), 2);
  // delayed old attempt should be ignored
  s2 = UI.applyStartupEvent(s2, status('LibreChat','ready',{attempt_id:1}), 2);
  assert.equal(s2.LibreChat, undefined);
  assert.equal(UI.shouldNavigate(Object.values(s2), false), false);
  s2 = UI.applyStartupEvent(s2, status('LibreChat','ready',{attempt_id:2}), 2);
  s2 = UI.applyStartupEvent(s2, status('MultiContext','ready',{attempt_id:2}), 2);
  assert.equal(UI.shouldNavigate(Object.values(s2), false), true);
});
// 15
test('no secrets returned in runtime status', async () => {
  const client = {
    listAgents: async () => [{ id:'a', name:'A'}],
    health: async () => ({ ok:true, agents:1, mode:'compat' }),
    runAgent: async () => ({ id:'r', text:'ok'})
  };
  await withServer(client, async ({ base }) => {
    const h = await jfetch(base, '/api/health');
    const serialized = JSON.stringify(h.data).toLowerCase();
    assert.equal(serialized.includes('sk-'), false);
    assert.equal(serialized.includes('bearer'), false);
    assert.equal(serialized.includes('librechat_api_key'), false);
    const ws = await jfetch(base, '/api/workspaces', { method:'POST', body: JSON.stringify({ name:'W' }) });
    const view = await jfetch(base, `/api/workspaces/${ws.data.id}`);
    const ser2 = JSON.stringify(view.data).toLowerCase();
    assert.equal(ser2.includes('sk-'), false);
    assert.equal(ser2.includes('bearer'), false);
  });
});
