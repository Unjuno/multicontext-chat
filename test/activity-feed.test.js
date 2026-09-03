import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActivityEvent, selectActivityEvents } from '../public/activity-feed.js';

const names = { a1: 'Analyst', b2: 'Fluid' };

test('mechanical lifecycle events render with actor and time', () => {
  const row = formatActivityEvent({ type: 'member.started', origin: 'system', memberId: 'a1', ts: '2026-09-03T17:00:01.000Z' }, names);
  assert.deepEqual(row, { time: '17:00:01', actor: 'Analyst', action: 'member started', target: null, detail: null, runId: null, origin: 'system' });
  assert.equal(formatActivityEvent({ type: 'member.completed', memberId: 'missing-id', ts: '2026-09-03T17:00:02.000Z' }, names).actor, 'missing-');
});

test('cross-chat tool events expose source and target without new channels', () => {
  const send = formatActivityEvent({
    type: 'tool.send_to_chat', origin: 'system', memberId: 'a1', ts: '2026-09-03T17:00:03.000Z',
    detail: { callId: 'c1', tool: 'send_to_chat', replayed: false, targets: ['Fluid', 'C-id-123456789'] },
  }, names);
  assert.equal(send.action, 'send_to_chat');
  assert.equal(send.actor, 'Analyst');
  assert.equal(send.target, 'Fluid, C-id-123456789');
  const inspect = formatActivityEvent({
    type: 'tool.inspect_chat', memberId: 'b2', ts: '2026-09-03T17:00:04.000Z',
    detail: { callId: 'c2', tool: 'inspect_chat', target: 'Analyst' },
  }, names);
  assert.equal(inspect.action, 'inspect_chat');
  assert.equal(inspect.target, 'Analyst');
  const list = formatActivityEvent({ type: 'tool.list_chats', memberId: 'a1', ts: 'x' }, names);
  assert.equal(list.target, null);
});

test('run, queue, human, and compile events render with run association', () => {
  assert.equal(formatActivityEvent({ type: 'mcp.run.started', runId: 'run-123456789', ts: 'x' }, names).action, 'run started');
  const settled = formatActivityEvent({ type: 'run.settled', runId: 'run-123456789', ts: 'x' }, names);
  assert.equal(settled.action, 'run settled');
  assert.equal(settled.runId, 'run-1234');
  const q = formatActivityEvent({ type: 'q.dispatched', origin: 'human', ts: 'x', detail: { broadcast: true } }, names);
  assert.equal(q.action, 'broadcast dispatched');
  const hb = formatActivityEvent({ type: 'human.broadcast', origin: 'human', ts: 'x' }, names);
  assert.equal(hb.action, 'broadcast sent');
  const mc = formatActivityEvent({ type: 'run.members.cancelled', runId: 'r', ts: 'x', detail: { cancelled: 3 } }, names);
  assert.equal(mc.detail, '3 items');
  assert.equal(formatActivityEvent({ type: 'compile.completed', ts: 'x' }, names).action, 'compile completed');
  assert.equal(formatActivityEvent({ type: 'orchestrator.paused', ts: 'x' }, names).action, 'orchestrator paused');
});

test('unknown types render nothing; tool.* fallback keeps raw type', () => {
  assert.equal(formatActivityEvent({ type: 'something.else', ts: 'x' }, names), null);
  assert.equal(formatActivityEvent(null, names), null);
  assert.equal(formatActivityEvent({ type: 'tool.future_tool', memberId: 'a1', ts: 'x' }, names).action, 'tool.future_tool');
});

test('selectActivityEvents returns newest-first bounded rows', () => {
  const events = [
    { type: 'member.started', memberId: 'a1', ts: '2026-09-03T17:00:01.000Z' },
    { type: 'something.else', ts: 'x' },
    { type: 'member.completed', memberId: 'a1', ts: '2026-09-03T17:00:02.000Z' },
    { type: 'run.settled', runId: 'r', ts: '2026-09-03T17:00:03.000Z' },
  ];
  const rows = selectActivityEvents(events, { limit: 2, memberNames: names });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'run settled');
  assert.equal(rows[1].action, 'member completed');
  assert.deepEqual(selectActivityEvents(null), []);
});
