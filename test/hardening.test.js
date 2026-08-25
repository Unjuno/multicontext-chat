import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makePath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-hardening-')), 'state.json');
const makeStore = () => new StateStore(makePath());

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

test('persisted in-flight item is recovered to the front of FIFO after restart', () => {
  const file = makePath();
  const first = new StateStore(file);
  const workspace = first.createWorkspace();
  const member = first.addMember(workspace.id, { name: 'A', agentId: 'a' });
  first.enqueue(workspace.id, member.id, 'first');
  first.enqueue(workspace.id, member.id, 'second');
  const started = first.beginNext(workspace.id, member.id);
  assert.equal(started.item.prompt, 'first');
  assert.equal(first.requireMember(workspace.id, member.id).member.current.item.prompt, 'first');

  const recovered = new StateStore(file);
  const after = recovered.requireMember(workspace.id, member.id).member;
  assert.equal(after.current, null);
  assert.equal(after.status, 'idle');
  assert.deepEqual(after.queue.map((item) => item.prompt), ['first', 'second']);
  assert.equal(after.messages.some((message) => message.pending), false);
});

test('failed run is requeued and blocks until explicit retry', () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const member = store.addMember(workspace.id, { name: 'A', agentId: 'a' });
  store.enqueue(workspace.id, member.id, 'work');
  const started = store.beginNext(workspace.id, member.id);
  assert.equal(store.failRun(workspace.id, member.id, started.item.id, 'boom'), true);
  const failed = store.requireMember(workspace.id, member.id).member;
  assert.equal(failed.status, 'error');
  assert.equal(failed.queue[0].prompt, 'work');
  assert.equal(failed.queue[0].attempts, 1);
  assert.equal(store.runtimeState(workspace.id), 'BLOCKED');

  store.retryMember(workspace.id, member.id);
  assert.equal(store.runtimeState(workspace.id), 'PENDING');
});

test('scheduler retries a failed front item only after Retry and preserves FIFO', async () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const member = store.addMember(workspace.id, { name: 'A', agentId: 'a' });
  store.enqueue(workspace.id, member.id, 'one');
  store.enqueue(workspace.id, member.id, 'two');
  let calls = 0;
  const seen = [];
  const client = {
    runAgent: async ({ prompt }) => {
      calls += 1;
      seen.push(prompt);
      if (calls === 1) throw new Error('transient');
      return { id: `r-${calls}`, text: `ok:${prompt}` };
    },
  };
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  scheduler.kickMember(workspace.id, member.id);
  await waitFor(() => store.requireMember(workspace.id, member.id).member.status === 'error');
  assert.deepEqual(seen, ['one']);
  assert.deepEqual(store.requireMember(workspace.id, member.id).member.queue.map((item) => item.prompt), ['one', 'two']);

  scheduler.retryMember(workspace.id, member.id);
  await waitFor(() => store.isSettled(workspace.id, scheduler.runningMemberIds(workspace.id)));
  assert.deepEqual(seen, ['one', 'one', 'two']);
  assert.deepEqual(
    store.requireMember(workspace.id, member.id).member.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
    ['ok:one', 'ok:two'],
  );
});

test('Stop suppresses a late result from an already-aborted generation', async () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const member = store.addMember(workspace.id, { name: 'A', agentId: 'a' });
  store.enqueue(workspace.id, member.id, 'slow');
  let resolveRun;
  const client = {
    runAgent: () => new Promise((resolve) => { resolveRun = resolve; }),
  };
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  scheduler.kickMember(workspace.id, member.id);
  await waitFor(() => store.requireMember(workspace.id, member.id).member.status === 'running');
  scheduler.stopMember(workspace.id, member.id);
  resolveRun({ id: 'late', text: 'must not be appended' });
  await sleep(20);
  const after = store.requireMember(workspace.id, member.id).member;
  assert.equal(after.current, null);
  assert.equal(after.queue.length, 0);
  assert.equal(after.status, 'idle');
  assert.equal(after.messages.some((message) => message.content === 'must not be appended'), false);
});

test('deactivating a member clears queued/current work and no longer blocks settlement', () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const member = store.addMember(workspace.id, { name: 'A', agentId: 'a' });
  store.enqueue(workspace.id, member.id, 'queued');
  store.updateMember(workspace.id, member.id, { active: false });
  const after = store.requireMember(workspace.id, member.id).member;
  assert.equal(after.active, false);
  assert.equal(after.queue.length, 0);
  assert.equal(after.current, null);
  assert.equal(store.runtimeState(workspace.id), 'SETTLED');
});

test('member references resolve by UUID or exact unique name and reject ambiguity', () => {
  const store = makeStore();
  const workspace = store.createWorkspace();
  const a = store.addMember(workspace.id, { name: 'Alpha' });
  assert.equal(store.resolveMember(workspace.id, a.id).id, a.id);
  assert.equal(store.resolveMember(workspace.id, 'Alpha').id, a.id);
  store.addMember(workspace.id, { name: 'Alpha' });
  assert.throws(() => store.resolveMember(workspace.id, 'Alpha'), /ambiguous/);
});
