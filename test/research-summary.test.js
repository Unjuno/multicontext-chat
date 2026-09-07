import test from 'node:test';
import assert from 'node:assert/strict';
import { researchSnapshots, researchSummaryPrompt, assertCompleteSynthesis } from '../src/research-summary.js';

test('synthesis retains provenance and explicitly reports omitted content', () => {
  const workspace = { members: { a: { id: 'a', name: 'Researcher', active: true,
    messages: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: 'x'.repeat(600) })) } } };
  const before = JSON.stringify(workspace);
  const snapshot = researchSnapshots(workspace);
  assert.equal(snapshot[0].omittedMessages, 2);
  assert.equal(snapshot[0].messages[0].id, 'm2');
  assert.equal(snapshot[0].messages[0].content.length, 500);
  assert.equal(snapshot[0].messages[0].truncated, true);
  assert.equal(snapshot[0].messages[0].originalCharacters, 600);
  assert.equal(JSON.stringify(workspace), before);
  assert.match(researchSummaryPrompt(snapshot), /NEXT_ACTION/);
  assert.match(researchSummaryPrompt(snapshot), /agreement is not verification/);
});

test('pending tool calls and empty synthesis are not completed reports', () => {
  assert.throws(() => assertCompleteSynthesis({ text: 'partial', raw: { output: [{ type: 'function_call' }] } }), { code: 'INCOMPLETE_SYNTHESIS' });
  assert.throws(() => assertCompleteSynthesis({ text: ' ' }), { code: 'INCOMPLETE_SYNTHESIS' });
  assert.doesNotThrow(() => assertCompleteSynthesis({ text: 'claims remain unverified' }));
});
