import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { CrossChatToolExecutor } from '../src/cross-chat-executor.js';

const makeFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-orch-audit-')), 'state.json');

function sendTool(targetId, prompt = 'child') {
  return [{ type: 'function_call', name: 'send_to_chat', call_id: `call-${Math.random()}`, arguments: JSON.stringify({ targets: [targetId], prompt }) }];
}

test('restart reconciliation never replays work owned by a recovered failed run, including receipt-only child deliveries', () => {
  const file = makeFile();
  const store1 = new StateStore(file);
  const ws = store1.createWorkspace({ name: 'W', defaultAgentId: 'a' });
  const member = store1.addMember(ws.id, { name: 'A', agentId: 'a' });
  const childMember = store1.addMember(ws.id, { name: 'B', agentId: 'a' });
  const run = store1.createOrchestratorRun(ws.id, { prompt: 'root' });
  const q = store1.enqueueOrchestrator(ws.id, 'root', { runId: run.id, target: { type: 'member', memberId: member.id } });
  store1.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store1.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  const owned = store1.enqueue(ws.id, member.id, 'run-owned', { source: 'orchestrator', orchestratorRunId: run.id, orchestratorQId: q.id });
  store1.beginNext(ws.id, member.id);
  store1.enqueue(ws.id, member.id, 'human survives', { source: 'user' });

  // Model the exact crash window: the atomic cross-chat receipt + child delivery is persisted,
  // but the executor has not yet attached orchestrator provenance to the child item.
  const child = store1.enqueue(ws.id, childMember.id, 'receipt child', { source: 'tool', sourceMemberId: member.id });
  const receiptKey = `${member.id}:${owned.id}:call-crash-window`;
  store1.getWorkspace(ws.id).crossChatReceipts[receiptKey] = {
    sourceMemberId: member.id,
    targetIds: [childMember.id],
    deliveries: [{ targetId: childMember.id, queueItemId: child.id }],
    result: { accepted: true, replayed: false, deliveries: [{ target: { id: childMember.id, name: childMember.name }, queue_item_id: child.id }] },
    committedAt: new Date().toISOString(),
  };
  store1.save();

  const store2 = new StateStore(file);
  const recovered = store2.getOrchestratorRun(ws.id, run.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, 'Recovered after restart');
  store2.getMember(ws.id, member.id).status = 'error';
  store2.save();
  const scheduler = new Scheduler({ store: store2, client: {}, maxHistoryMessages: 20 });
  scheduler.resumeAll();

  const afterMember = store2.getMember(ws.id, member.id);
  assert.equal(afterMember.queue.some(item => item.id === owned.id), false);
  assert.equal(afterMember.queue.some(item => item.prompt === 'human survives'), true);
  assert.equal(store2.getMember(ws.id, childMember.id).queue.some(item => item.id === child.id), false);
  const afterQ = store2.getWorkspace(ws.id).orchestratorQueue.find(item => item.id === q.id);
  assert.equal(afterQ.state, 'failed');
});

test('restart reconciles torn run-status/Q saves: settled run with dispatched Q becomes done', () => {
  const file = makeFile();
  const store1 = new StateStore(file);
  const ws = store1.createWorkspace({ name: 'W', defaultAgentId: 'a' });
  store1.addMember(ws.id, { name: 'A', agentId: 'a' });
  const run = store1.createOrchestratorRun(ws.id, { prompt: 'root' });
  const q = store1.enqueueOrchestrator(ws.id, 'root', { runId: run.id });
  store1.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  store1.updateOrchestratorQueueItem(ws.id, q.id, { state: 'dispatched' });
  // Crash tears the two settle saves apart: run persisted as settled, Q still dispatched.
  store1.updateOrchestratorRun(ws.id, run.id, { status: 'settled' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawQ = raw.workspaces[ws.id].orchestratorQueue.find((item) => item.id === q.id);
  assert.equal(raw.workspaces[ws.id].orchestratorRuns[run.id].status, 'settled');
  assert.equal(rawQ.state, 'dispatched');

  const store2 = new StateStore(file);
  const afterQ = store2.getWorkspace(ws.id).orchestratorQueue.find((item) => item.id === q.id);
  assert.equal(afterQ.state, 'done');
  assert.ok(afterQ.doneAt);
  assert.equal(store2.getOrchestratorState(ws.id).counts.pending, 0);
});

test('cross-chat send recursively inherits orchestrator run/Q provenance', async () => {
  const store = new StateStore(makeFile());
  const ws = store.createWorkspace({ name: 'W' });
  const a = store.addMember(ws.id, { name: 'A' });
  const b = store.addMember(ws.id, { name: 'B' });
  const c = store.addMember(ws.id, { name: 'C' });
  const run = store.createOrchestratorRun(ws.id, { prompt: 'root' });
  const q = store.enqueueOrchestrator(ws.id, 'root', { runId: run.id });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'running' });

  const app = {
    _store: store,
    _scheduler: { abortByOrchestratorRun: () => 0 },
    async sendToChats(workspaceId, sourceMemberId, targets, prompt) {
      const target = store.resolveMember(workspaceId, targets[0]);
      const item = store.enqueue(workspaceId, target.id, prompt, { source: 'tool', sourceMemberId });
      return { accepted: true, replayed: false, deliveries: [{ target: { id: target.id, name: target.name }, queue_item_id: item.id }] };
    },
  };
  const executor = new CrossChatToolExecutor({ app });
  await executor.execute({ workspaceId: ws.id, sourceMemberId: a.id, sourceQueueItemId: 'root-member-item', sourceOrchestratorRunId: run.id, sourceOrchestratorQId: q.id, toolCalls: sendTool(b.id) });
  const child = store.getMember(ws.id, b.id).queue[0];
  assert.equal(child.orchestratorRunId, run.id);
  assert.equal(child.orchestratorQId, q.id);

  await executor.execute({ workspaceId: ws.id, sourceMemberId: b.id, sourceQueueItemId: child.id, sourceOrchestratorRunId: child.orchestratorRunId, sourceOrchestratorQId: child.orchestratorQId, toolCalls: sendTool(c.id, 'grandchild') });
  const grandchild = store.getMember(ws.id, c.id).queue[0];
  assert.equal(grandchild.orchestratorRunId, run.id);
  assert.equal(grandchild.orchestratorQId, q.id);
});

test('send_to_chat committed during run cancellation is compensated after provenance attachment', async () => {
  const store = new StateStore(makeFile());
  const ws = store.createWorkspace({ name: 'W' });
  const a = store.addMember(ws.id, { name: 'A' });
  const b = store.addMember(ws.id, { name: 'B' });
  const run = store.createOrchestratorRun(ws.id, { prompt: 'root' });
  const q = store.enqueueOrchestrator(ws.id, 'root', { runId: run.id });
  store.updateOrchestratorRun(ws.id, run.id, { status: 'running' });
  let abortCalls = 0;
  const app = {
    _store: store,
    _scheduler: { abortByOrchestratorRun: () => { abortCalls += 1; return 0; } },
    async sendToChats(workspaceId, sourceMemberId, targets, prompt) {
      store.updateOrchestratorRun(workspaceId, run.id, { status: 'cancelled' });
      const target = store.resolveMember(workspaceId, targets[0]);
      const item = store.enqueue(workspaceId, target.id, prompt, { source: 'tool', sourceMemberId });
      return { accepted: true, replayed: false, deliveries: [{ target: { id: target.id, name: target.name }, queue_item_id: item.id }] };
    },
  };
  const executor = new CrossChatToolExecutor({ app });
  await assert.rejects(
    () => executor.execute({ workspaceId: ws.id, sourceMemberId: a.id, sourceQueueItemId: 'root-member-item', sourceOrchestratorRunId: run.id, sourceOrchestratorQId: q.id, toolCalls: sendTool(b.id) }),
    (error) => error?.code === 'ABORTED'
  );
  assert.equal(abortCalls, 1);
  assert.equal(store.getMember(ws.id, b.id).queue.length, 0);
  assert.equal(store.getOrchestratorRun(ws.id, run.id).status, 'cancelled');
});