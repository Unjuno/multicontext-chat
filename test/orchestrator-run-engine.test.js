import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { registerOrchestratorTools } from '../src/mcp/orchestrator.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-run-engine-')), 'state.json'));
const makeServer = () => {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _spec, handler) { handlers.set(name, handler); },
  };
};

test('cancel_run aborts only run-owned in-flight work and preserves human queue', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name: 'W' });
  const member = store.addMember(ws.id, { name: 'A' });
  const run = store.createOrchestratorRun(ws.id, { prompt: 'orchestrated' });
  const q = store.enqueueOrchestrator(ws.id, 'orchestrated', { runId: run.id, target: { type: 'member', memberId: member.id } });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  store.enqueue(ws.id, member.id, 'orchestrated', { source: 'orchestrator', orchestratorRunId: run.id, orchestratorQId: q.id });
  store.enqueue(ws.id, member.id, 'human', { source: 'user' });
  const prepared = store.beginNext(ws.id, member.id);
  assert.equal(prepared.item.orchestratorRunId, run.id);

  let abortCalls = 0;
  const app = {
    _scheduler: { abortByOrchestratorRun(workspaceId, runId) { abortCalls++; assert.equal(workspaceId, ws.id); assert.equal(runId, run.id); return 1; } },
  };
  const server = makeServer();
  registerOrchestratorTools(server, app, store);
  const result = await server.handlers.get('multicontext_orchestrate_cancel_run')({ workspace_id: ws.id, run_id: run.id });

  assert.equal(abortCalls, 1);
  assert.equal(result.structuredContent.aborted, 1);
  assert.equal(store.getOrchestratorRun(ws.id, run.id).status, 'cancelled');
  const remaining = store.getMember(ws.id, member.id).queue;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].prompt, 'human');
  assert.equal(store.getMember(ws.id, member.id).current, null);
});

test('resume dispatch preserves direct target and run/Q provenance', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name: 'W' });
  const member = store.addMember(ws.id, { name: 'B' });
  store.setOrchestratorPaused(ws.id, true);
  const calls = [];
  const app = {
    _scheduler: { abortByOrchestratorRun: () => 0 },
    send: async (workspaceId, memberId, prompt, metadata) => { calls.push({ kind: 'send', workspaceId, memberId, prompt, metadata }); return { item: { id: 'm1' } }; },
    broadcast: async () => { calls.push({ kind: 'broadcast' }); return {}; },
    waitUntilSettled: async () => ({ state: 'SETTLED' }),
  };
  const server = makeServer();
  registerOrchestratorTools(server, app, store);

  const started = await server.handlers.get('multicontext_orchestrate_start_run')({ workspace_id: ws.id, prompt: 'direct', chat_id: member.id });
  assert.equal(started.structuredContent.paused, true);
  const runId = started.structuredContent.run_id;
  const qId = started.structuredContent.qItem.id;

  const resumed = await server.handlers.get('multicontext_orchestrate_set_paused')({ workspace_id: ws.id, paused: false });
  assert.equal(resumed.structuredContent.resumed_run_id, runId);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'send');
  assert.equal(calls[0].memberId, member.id);
  assert.deepEqual(calls[0].metadata, { orchestratorRunId: runId, orchestratorQId: qId });
  assert.equal(store.getOrchestratorRun(ws.id, runId).status, 'settled');
});

test('compat run uses same target/provenance semantics as async run', async () => {
  const store = makeStore();
  const ws = store.createWorkspace({ name: 'W' });
  const member = store.addMember(ws.id, { name: 'B' });
  const calls = [];
  const app = {
    _scheduler: { abortByOrchestratorRun: () => 0 },
    send: async (workspaceId, memberId, prompt, metadata) => { calls.push({ workspaceId, memberId, prompt, metadata }); return { item: { id: `m${calls.length}` } }; },
    broadcast: async () => { throw new Error('unexpected broadcast'); },
    waitUntilSettled: async () => ({ state: 'SETTLED' }),
  };
  const server = makeServer();
  registerOrchestratorTools(server, app, store);

  const compat = await server.handlers.get('multicontext_orchestrate_run')({ workspace_id: ws.id, prompt: 'sync', chat_id: member.id, timeout_seconds: 5 });
  const compatRun = compat.structuredContent.run_id;
  assert.equal(store.getOrchestratorRun(ws.id, compatRun).status, 'settled');
  assert.equal(calls[0].memberId, member.id);
  assert.equal(calls[0].metadata.orchestratorRunId, compatRun);
  assert.ok(calls[0].metadata.orchestratorQId);

  const asyncStart = await server.handlers.get('multicontext_orchestrate_start_run')({ workspace_id: ws.id, prompt: 'async', chat_id: member.id });
  await new Promise(resolve => setTimeout(resolve, 20));
  const asyncRun = asyncStart.structuredContent.run_id;
  assert.equal(store.getOrchestratorRun(ws.id, asyncRun).status, 'settled');
  assert.equal(calls[1].memberId, member.id);
  assert.equal(calls[1].metadata.orchestratorRunId, asyncRun);
  assert.ok(calls[1].metadata.orchestratorQId);
});

test('Scheduler.setApp exposes private scheduler link and abortByOrchestratorRun aborts controller', () => {
  const store = makeStore();
  const scheduler = new Scheduler({ store, client: {}, maxHistoryMessages: 20 });
  const app = {};
  scheduler.setApp(app);
  assert.equal(app._scheduler, scheduler);

  const ws = store.createWorkspace({ name: 'W' });
  const member = store.addMember(ws.id, { name: 'A' });
  const item = store.enqueue(ws.id, member.id, 'x', { source: 'orchestrator', orchestratorRunId: 'run-1', orchestratorQId: 'q-1' });
  store.beginNext(ws.id, member.id);
  const controller = new AbortController();
  scheduler.running.set(scheduler.key(ws.id, member.id), controller);

  assert.equal(scheduler.abortByOrchestratorRun(ws.id, 'run-1'), 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(item.orchestratorRunId, 'run-1');
});
