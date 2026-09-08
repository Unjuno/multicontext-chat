import test from 'node:test';
import assert from 'node:assert/strict';
import { researchSnapshots, compileToolAudit, researchSummaryPrompt, assertCompleteSynthesis } from '../src/research-summary.js';

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
  assert.doesNotMatch(researchSummaryPrompt(snapshot), /Use four sections/);
  assert.match(researchSummaryPrompt(snapshot), /tool success is not an accepted assessment/);
  assert.match(researchSummaryPrompt(snapshot), /Do not create SEARCH AUDIT or TOOL AUDIT sections/);
});

test('pending tool calls and empty synthesis are not completed reports', () => {
  assert.throws(() => assertCompleteSynthesis({ text: 'partial', raw: { output: [{ type: 'function_call' }] } }), { code: 'INCOMPLETE_SYNTHESIS' });
  assert.throws(() => assertCompleteSynthesis({ text: ' ' }), { code: 'INCOMPLETE_SYNTHESIS' });
  assert.doesNotThrow(() => assertCompleteSynthesis({ text: 'claims remain unverified' }));
});

test('synthesis retains member-scoped tool attribution', () => {
  const toolEvidence = { scope: 'MULTICONTEXT_TOOLS_THIS_ATTEMPT', attempted: 1, succeeded: 1, failed: 0, replayed: 0,
    calls: [{ callId: 'calc-b2', tool: 'calculate', status: 'succeeded', calculation: { expression: '2/(1-3/6)', value: 4, proofVerified: false } }], omittedCalls: 0 };
  const workspace = { members: { b2: { id: 'b2', name: 'Algebra reviser', active: true,
    messages: [{ id: 'answer-b2', role: 'assistant', content: 'Delivered.', toolEvidence }] } } };
  const snapshot = researchSnapshots(workspace);
  assert.deepEqual(snapshot[0].messages[0].toolEvidence, toolEvidence);
  const prompt = researchSummaryPrompt(snapshot);
  assert.match(prompt, /calc-b2/);
  assert.match(prompt, /member\/message\/call attribution exactly/);
});

test('Compile tool audit deterministically counts and attributes recorded calls', () => {
  const evidence = (calls, omittedCalls = 0) => ({ scope: 'MULTICONTEXT_TOOLS_THIS_ATTEMPT', attempted: calls.length + omittedCalls,
    succeeded: calls.length + omittedCalls, failed: 0, replayed: 0, calls, omittedCalls });
  const snapshots = [{ member: { id: 'b1', name: 'Metadata verifier' }, messages: [
    { id: 'm1', role: 'assistant', toolEvidence: evidence([{ callId: 'search-b1', tool: 'search_sources', status: 'succeeded', search: { requestedDoi: '10.1007/example', resultCount: 1 } }]) },
  ] }, { member: { id: 'b2', name: 'Algebra reviser' }, messages: [
    { id: 'm2', role: 'assistant', toolEvidence: evidence([{ callId: 'calc-b2', tool: 'calculate', status: 'succeeded', calculation: { expression: '2+2', value: 4, proofVerified: true } }]) },
    { id: 'old', role: 'assistant', toolEvidence: { scope: 'UNRECORDED' } },
  ] }];
  const audit = compileToolAudit(snapshots);
  assert.deepEqual(audit.totals, { attempted: 2, succeeded: 2, failed: 0, replayed: 0 });
  assert.equal(audit.byTool.calculate.attempted, 1);
  assert.equal(audit.byTool.search_sources.attempted, 1);
  assert.deepEqual(audit.calls.map(call => [call.memberId, call.messageId, call.callId]), [
    ['b1', 'm1', 'search-b1'], ['b2', 'm2', 'calc-b2'],
  ]);
  assert.equal(audit.calls[1].calculation.proofVerified, false);
  assert.equal(audit.coverage.unrecordedAssistantMessages, 1);
  assert.equal(audit.verification, 'EXECUTION_TELEMETRY_NOT_CONTENT_CORRECTNESS_OR_PROOF');
  const prompt = researchSummaryPrompt(snapshots, audit);
  assert.match(prompt, /DETERMINISTIC_TOOL_AUDIT/);
  assert.match(prompt, /rendered separately by MultiContext/);
  assert.match(prompt, /tool-evidence coverage is incomplete/);
});
