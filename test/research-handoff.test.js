import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewContext, distilledContext, messageHandoff } from '../src/research-handoff.js';

test('handoff scopes reviews and explicitly records omitted/truncated evidence', () => {
  const ws = { reviewNotes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), memberId: i ? 'a' : 'b', messageId: `m${i}`, verdict: 'rejected', rationale: 'x'.repeat(450) })) };
  const review = reviewContext(ws, 'a');
  assert.equal(review.reviewNotes.length, 8);
  assert.equal(review.omittedReviewNotes, 1);
  assert.ok(review.reviewNotes.every(n => n.memberId === 'a'));
  const result = distilledContext('body'.repeat(4000), review);
  assert.equal(result.distilled.length, 8000);
  assert.equal(result.distilledTruncated, true);
  assert.match(result.distilled, /"rationaleTruncated":true/);
  assert.equal(review.reviewNotes[0].rationale.length, 450);
  assert.equal(messageHandoff({ id: 'm', role: 'user', pending: true, content: '12345' }, 3).pending, true);
  assert.deepEqual(messageHandoff({ role: 'assistant', content: '12345' }, 3).searchEvidence, { scope: 'UNRECORDED' });
  assert.deepEqual(messageHandoff({ role: 'assistant', content: '12345' }, 3).toolEvidence, { scope: 'UNRECORDED' });
});
