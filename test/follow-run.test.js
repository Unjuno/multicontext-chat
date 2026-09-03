import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDisplayedRun, followedRunState, isTerminalRunStatus } from '../public/follow-run.js';

const running = { id: 'r1', status: 'running' };
const queued = { id: 'r2', status: 'queued' };
const settled = { id: 'r3', status: 'settled' };
const failed = { id: 'r4', status: 'failed' };

test('terminal statuses match the orchestrator engine', () => {
  for (const s of ['settled', 'blocked', 'failed', 'cancelled']) assert.equal(isTerminalRunStatus(s), true);
  for (const s of ['running', 'queued', 'pending', '', null, undefined]) assert.equal(isTerminalRunStatus(s), false);
});

test('no hint derives current run exactly like before', () => {
  assert.deepEqual(pickDisplayedRun([settled, running, queued], null), { run: running, following: false });
  assert.deepEqual(pickDisplayedRun([settled], null), { run: settled, following: false });
  assert.deepEqual(pickDisplayedRun([], null), { run: null, following: false });
  assert.deepEqual(pickDisplayedRun(null, null), { run: null, following: false });
});

test('explicit hint follows the live run, drops only when terminal', () => {
  assert.deepEqual(pickDisplayedRun([running, queued], 'r2'), { run: queued, following: true });
  assert.equal(followedRunState([running, queued], 'r2'), 'following');
  // terminal run id: fall back to derived current, hint droppable
  assert.deepEqual(pickDisplayedRun([running, settled], 'r3'), { run: running, following: false });
  assert.equal(followedRunState([running, settled], 'r3'), 'terminal');
  assert.equal(followedRunState([failed], 'r4'), 'terminal');
  // unknown id (state lags creation): fall back but keep the hint
  assert.deepEqual(pickDisplayedRun([running], 'r-missing'), { run: running, following: false });
  assert.equal(followedRunState([running], 'r-missing'), 'unknown');
  assert.equal(followedRunState([], null), 'none');
});
