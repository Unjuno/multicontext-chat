import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActivityEvent, selectActivityEvents } from '../public/activity-feed.js';

const names = { a1: 'Analyst', b2: 'Fluid' };

test('mechanical lifecycle events render with actor and time', () => {
  const row = formatActivityEvent({ type: 'member.started', origin: 'system', memberId: 'a1', ts: '2026-09-03T17:00:01.000Z' }, names);
  assert.deepEqual(row, { time: '17:00:01', actor: 'Analyst', action: 'メンバーの実行を開始', target: null, detail: null, runId: null, origin: 'system' });
  assert.equal(formatActivityEvent({ type: 'member.completed', memberId: 'missing-id', ts: '2026-09-03T17:00:02.000Z' }, names).actor, 'missing-');
});

test('failed tool calls display failure and error code', () => {
  const row = formatActivityEvent({ type: 'tool.failed', detail: { tool: 'send_to_chat', code: 'NOT_FOUND', target: 'auditor' } });
  assert.equal(row.action, 'ツール実行に失敗');
  assert.equal(row.detail, 'NOT_FOUND');
  assert.equal(row.target, 'auditor');
});

test('cross-chat tool events expose source and target without new channels', () => {
  const send = formatActivityEvent({
    type: 'tool.send_to_chat', origin: 'system', memberId: 'a1', ts: '2026-09-03T17:00:03.000Z',
    detail: { callId: 'c1', tool: 'send_to_chat', replayed: false, targets: ['Fluid', 'C-id-123456789'] },
  }, names);
  assert.equal(send.action, 'チャットへ送信');
  assert.equal(send.actor, 'Analyst');
  assert.equal(send.target, 'Fluid, C-id-123456789');
  const inspect = formatActivityEvent({
    type: 'tool.inspect_chat', memberId: 'b2', ts: '2026-09-03T17:00:04.000Z',
    detail: { callId: 'c2', tool: 'inspect_chat', target: 'Analyst' },
  }, names);
  assert.equal(inspect.action, 'チャットを確認');
  assert.equal(inspect.target, 'Analyst');
  const list = formatActivityEvent({ type: 'tool.list_chats', memberId: 'a1', ts: 'x' }, names);
  assert.equal(list.target, null);
});

test('run, queue, human, and compile events render with run association', () => {
  assert.equal(formatActivityEvent({ type: 'mcp.run.started', runId: 'run-123456789', ts: 'x' }, names).action, '実行を開始');
  const settled = formatActivityEvent({ type: 'run.settled', runId: 'run-123456789', ts: 'x' }, names);
  assert.equal(settled.action, '実行が完了');
  assert.equal(settled.runId, 'run-1234');
  const q = formatActivityEvent({ type: 'q.dispatched', origin: 'human', ts: 'x', detail: { broadcast: true } }, names);
  assert.equal(q.action, 'ブロードキャストを配信');
  const hb = formatActivityEvent({ type: 'human.broadcast', origin: 'human', ts: 'x' }, names);
  assert.equal(hb.action, 'ブロードキャスト送信');
  const mc = formatActivityEvent({ type: 'run.members.cancelled', runId: 'r', ts: 'x', detail: { cancelled: 3 } }, names);
  assert.equal(mc.detail, '3件');
  assert.equal(formatActivityEvent({ type: 'compile.completed', ts: 'x' }, names).action, 'Compileが完了');
  assert.equal(formatActivityEvent({ type: 'orchestrator.paused', ts: 'x' }, names).action, 'オーケストレーターを一時停止');
});

test('unknown types render nothing; tool.* fallback keeps raw type', () => {
  assert.equal(formatActivityEvent({ type: 'something.else', ts: 'x' }, names), null);
  assert.equal(formatActivityEvent(null, names), null);
  assert.equal(formatActivityEvent({ type: 'tool.future_tool', memberId: 'a1', ts: 'x' }, names).action, 'ツールを実行');
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
  assert.equal(rows[0].action, '実行が完了');
  assert.equal(rows[1].action, 'メンバーの実行が完了');
  assert.deepEqual(selectActivityEvents(null), []);
});
