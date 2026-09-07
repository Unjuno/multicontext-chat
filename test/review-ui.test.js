import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSubmission, reviewNotesHtml } from '../public/review-notes.js';

test('GUI review submission retains exact source identity and server validation limits', () => {
  const target = { memberId: 'member', messageId: 'source' };
  const values = { verdict: 'needs_check', rationale: '  Check assumptions\nNot a proof  ', reviewer: ' User ' };
  assert.deepEqual(reviewSubmission(target, { ...values, memberId: 'forged', messageId: 'forged' }),
    { ...target, verdict: 'needs_check', rationale: 'Check assumptions\nNot a proof', reviewer: 'User' });
  for (const patch of [{ verdict: 'verified' }, { verdict: '__proto__' }, { rationale: ' ' }, { rationale: 'x'.repeat(2001) }, { reviewer: '' }, { reviewer: 'x'.repeat(121) }]) {
    assert.throws(() => reviewSubmission(target, { ...values, ...patch }));
  }
  assert.equal(reviewSubmission(target, { ...values, rationale: 'x'.repeat(2000), reviewer: 'x'.repeat(120) }).rationale.length, 2000);
});

test('review display escapes original content, limits details and preserves disclosure state', () => {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const notes = Array.from({ length: 4 }, (_, i) => ({ verdict: 'rejected', reviewer: '<b>user</b>', at: 'today', rationale: `note${i}<script>bad</script>` }));
  const html = reviewNotesHtml(notes, esc, { key: 'member:message', open: true });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>user</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('note0'));
  assert.ok(html.includes('最新3件'));
  assert.ok(html.includes('data-review-key="member:message" open'));
  assert.equal(reviewNotesHtml([], esc), '');
});
