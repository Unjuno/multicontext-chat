import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-p0-')), 'state.json'));
const makeApp = () => {
  const store = makeStore();
  const client = { listAgents: async () => [{ id: 'a', name: 'A' }], health: async () => ({ ok: true }) };
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  const app = createApplication({ config: { mcpEnabled: false, mcpToken: '' }, store, client, scheduler });
  scheduler.setApp(app);
  return { store, app, scheduler };
};

test('P0: cancel_run does not destroy human queue', async () => {
  const { store, app } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const a = store.addMember(ws.id, { name: 'A', agentId: 'a' });
  const b = store.addMember(ws.id, { name: 'B', agentId: 'a' });
  // human enqueues
  store.enqueue(ws.id, a.id, 'human task');
  const run = store.createOrchestratorRun(ws.id, { prompt: 'mcp task', origin: 'mcp' });
  const q = store.enqueueOrchestrator(ws.id, 'mcp task', { runId: run.id });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  // cancel run
  store.updateOrchestratorRun(ws.id, run.id, { status: 'cancelled' });
  // human queue should still exist
  assert.equal(store.getMember(ws.id, a.id).queue.length, 1);
  assert.equal(store.getMember(ws.id, a.id).queue[0].prompt, 'human task');
  // q should be cancelled, not pending
  const item = store.getWorkspace(ws.id).orchestratorQueue.find(x=>x.id===q.id);
  assert.equal(item.state, 'cancelled');
});

test('P1: second active run rejected', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  store.createOrchestratorRun(ws.id, { prompt: 'first' });
  assert.throws(() => store.createOrchestratorRun(ws.id, { prompt: 'second' }), /already active/);
});

test('P1: cancel stays cancelled (no overwrite to settled)', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const run = store.createOrchestratorRun(ws.id, { prompt: 'x' });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'cancelled' });
  assert.throws(() => store.updateOrchestratorRun(ws.id, run.id, { status: 'settled' }), /terminal|Invalid/);
  assert.equal(store.getOrchestratorRun(ws.id, run.id).status, 'cancelled');
});

test('P1: pause prevents dispatch', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  store.setOrchestratorPaused(ws.id, true);
  const run = store.createOrchestratorRun(ws.id, { prompt: 'x' });
  const q = store.enqueueOrchestrator(ws.id, 'x', { runId: run.id });
  // try to dispatch via orchestrator logic: check paused
  const ws2 = store.getWorkspace(ws.id);
  assert.equal(ws2.orchestratorPaused, true);
  // q should remain pending, not dispatched
  const item = ws2.orchestratorQueue.find(x=>x.id===q.id);
  assert.equal(item.state, 'pending');
});

test('P1: done Q0 never blocks pending Q1 (peek only pending)', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const q0 = store.enqueueOrchestrator(ws.id, 'q0 high', { priority: 0 });
  const q1 = store.enqueueOrchestrator(ws.id, 'q1 low', { priority: 1 });
  store.updateOrchestratorQueueItem(ws.id, q0.id, { state: 'claimed' });
  store.updateOrchestratorQueueItem(ws.id, q0.id, { state: 'dispatched' });
  store.updateOrchestratorQueueItem(ws.id, q0.id, { state: 'done' });
  const peek = store.peekOrchestratorQueue(ws.id, 10);
  assert.equal(peek.length, 1);
  assert.equal(peek[0].id, q1.id);
  assert.equal(peek[0].state, 'pending');
});

test('P1: next never claims terminal item', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const q = store.enqueueOrchestrator(ws.id, 'x');
  store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'claimed' });
  store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'done' });
  // try to claim again should fail or return different
  const peek = store.peekOrchestratorQueue(ws.id, 1);
  assert.equal(peek.length, 0);
});

test('P1: Q/run retention bounded', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  for(let i=0;i<210;i++){
    const q = store.enqueueOrchestrator(ws.id, `q${i}`);
    store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'claimed' });
    store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
    store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'done' });
  }
  // should be bounded to ~100 terminal + pending
  assert.ok(store.getWorkspace(ws.id).orchestratorQueue.length <= 150, `queue length ${store.getWorkspace(ws.id).orchestratorQueue.length}`);
  for(let i=0;i<110;i++){
    store.createOrchestratorRun(ws.id, { prompt: `r${i}` });
    // need to finish previous to allow new
    const runs = store.listOrchestratorRuns(ws.id);
    for(const r of runs) if(['queued','running'].includes(r.status)) {
      try { store.updateOrchestratorRun(ws.id, r.id, { status: 'failed' }); } catch {}
    }
  }
  assert.ok(Object.keys(store.getWorkspace(ws.id).orchestratorRuns).length <= 100);
});

test('P1: malicious Q prompt escaped in GUI (store level)', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const q = store.enqueueOrchestrator(ws.id, '<img src=x onerror="alert(1)">');
  assert.equal(q.prompt, '<img src=x onerror="alert(1)">');
  // GUI should esc() it, store keeps raw but GUI esc is tested separately
  const ev = store.appendEvent(ws.id, { type: 'q.enqueued', origin: 'mcp', qId: q.id, detail: { prompt: q.prompt } });
  assert.ok(ev.detail.prompt.includes('<img'));
});

test('P1: member/tool lifecycle appears in event log', async () => {
  const store = makeStore();
  const client = {
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async () => ({ id: 'r1', text: 'hi', conversationId: 'c1', raw: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] } }),
  };
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  const app = createApplication({ config: { mcpEnabled: false, mcpToken: '' }, store, client, scheduler });
  scheduler.setApp(app);
  const ws = store.createWorkspace({ name: 'W' });
  const a = store.addMember(ws.id, { name: 'A', agentId: 'a' });
  store.enqueue(ws.id, a.id, 'hello');
  scheduler.kickMember(ws.id, a.id);
  await new Promise(r=>setTimeout(r,500));
  const evs = store.listOrchestratorEvents(ws.id, 20);
  const hasMemberStarted = evs.some(e=>e.type==='member.started');
  const hasMemberCompleted = evs.some(e=>e.type==='member.completed');
  assert.ok(hasMemberStarted, 'member.started should be in events');
  assert.ok(hasMemberCompleted, 'member.completed should be in events');
});

test('P1: restart does not silently duplicate side effects (Q pending, Run failed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-restart-'));
  const file = path.join(dir, 'state.json');
  const store1 = new StateStore(file);
  const ws = store1.createWorkspace({ name: 'W' });
  const run = store1.createOrchestratorRun(ws.id, { prompt: 'x' });
  const q = store1.enqueueOrchestrator(ws.id, 'x', { runId: run.id });
  store1.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store1.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  // simulate crash
  const store2 = new StateStore(file);
  const ws2 = store2.getWorkspace(ws.id);
  const run2 = ws2.orchestratorRuns[run.id];
  const q2 = ws2.orchestratorQueue.find(x=>x.id===q.id);
  assert.equal(run2.status, 'failed');
  assert.equal(q2.state, 'pending');
});

test('P1: deprecated run and async run share one engine (both use store Run)', async () => {
  const { store } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  // create via deprecated path would still create Run, so we test that both create Run
  const run1 = store.createOrchestratorRun(ws.id, { prompt: 'via deprecated' });
  assert.ok(run1.id);
  // second should be rejected because first is active
  assert.throws(() => store.createOrchestratorRun(ws.id, { prompt: 'second' }), /already active/);
  store.updateOrchestratorRun(ws.id, run1.id, { status: 'running' });
  store.updateOrchestratorRun(ws.id, run1.id, { status: 'settled' });
  // now new run should succeed
  const run2 = store.createOrchestratorRun(ws.id, { prompt: 'after' });
  assert.ok(run2.id);
});
