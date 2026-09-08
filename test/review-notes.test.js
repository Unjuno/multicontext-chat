import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { researchSnapshots } from '../src/research-summary.js';
import { createApplication } from '../src/application.js';
import { CrossChatToolExecutor } from '../src/cross-chat-executor.js';

test('native peer inspection carries rejected reviews without exposing other members or changing history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-inspect-review-'));
  try {
    const store = new StateStore(path.join(dir, 'state.json'));
    const ws = store.createWorkspace({});
    const reader = store.addMember(ws.id, { name: 'Reader' });
    const author = store.addMember(ws.id, { name: 'Author' });
    reader.messages.push({ id: 'private', role: 'assistant', content: 'Other context' });
    author.messages.push({ id: 'claim', role: 'assistant', content: 'Candidate identity' });
    const note = store.addReviewNote(ws.id, { memberId: author.id, messageId: 'claim', verdict: 'rejected', rationale: 'Matrix counterexample', reviewer: 'Orchestrator' });
    store.addReviewNote(ws.id, { memberId: reader.id, messageId: 'private', verdict: 'needs_check', rationale: 'Unrelated private review', reviewer: 'Orchestrator' });
    const app = createApplication({ config: {}, store, client: {}, scheduler: {} });
    const before = JSON.stringify([reader.messages, author.messages, reader.queue, author.queue]);
    const result = await app.inspectPeerChat(ws.id, reader.id, author.id);
    assert.equal(result.verificationStatus, 'UNREVIEWED');
    assert.equal(result.assessmentNotProof, true);
    assert.deepEqual(result.reviewNotes.map(n => n.id), [note.id]);
    assert.equal(result.reviewNotes[0].messageId, 'claim');
    const outputs = await new CrossChatToolExecutor({ app }).execute({
      workspaceId: ws.id, sourceMemberId: reader.id,
      toolCalls: [{ call_id: 'inspect-review', name: 'inspect_chat', arguments: JSON.stringify({ target: author.id }) }],
    });
    assert.equal(outputs[0].call_id, 'inspect-review');
    assert.equal(JSON.parse(outputs[0].output).reviewNotes[0].verdict, 'rejected');
    assert.equal(JSON.stringify([reader.messages, author.messages, reader.queue, author.queue]), before);
    reader.canInspectOthers = false;
    await assert.rejects(app.inspectPeerChat(ws.id, reader.id, author.id), { code: 'CROSS_CHAT_INSPECT_DISABLED' });
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('workspace duplication rekeys members and preserves attributable review references', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-review-copy-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    const source = store.createWorkspace({});
    const member = store.addMember(source.id, { name: 'Author' });
    member.messages.push({ id: 'claim', role: 'assistant', content: 'Candidate estimate' });
    const note = store.addReviewNote(source.id, { memberId: member.id, messageId: 'claim', verdict: 'needs_check', rationale: 'Check assumptions', reviewer: 'Reviewer' });
    const before = JSON.stringify(source);
    const copy = store.duplicateWorkspace(source.id);
    const copiedMember = Object.values(copy.members).find(m => m.name === 'Author');
    assert.notEqual(copiedMember.id, member.id);
    for (const [key, value] of Object.entries(copy.members)) assert.equal(key, value.id);
    assert.equal(copy.reviewNotes[0].memberId, copiedMember.id);
    assert.deepEqual(copy.reviewNotes[0].copiedFrom, { workspaceId: source.id, reviewId: note.id, memberId: member.id });
    assert.equal(copy.reviewNotes[0].sourceHash, note.sourceHash);
    assert.equal(researchSnapshots(copy).find(s => s.member.id === copiedMember.id).assessments[0].id, note.id);
    store.addReviewNote(copy.id, { memberId: copiedMember.id, messageId: 'claim', verdict: 'rejected', rationale: 'Counterexample', reviewer: 'Reviewer' });
    assert.equal(JSON.stringify(source), before);
    assert.equal(new StateStore(file).getWorkspace(copy.id).reviewNotes.length, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('review records persist provenance without changing messages or queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-review-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    const workspace = store.createWorkspace({});
    const member = store.addMember(workspace.id, { name: 'Author' });
    member.messages.push({ id: 'source', role: 'assistant', content: 'P exponent is 1.5' });
    store.save();
    const before = JSON.stringify(member);
    const record = store.addReviewNote(workspace.id, { memberId: member.id, messageId: 'source', verdict: 'rejected',
      rationale: 'With P defined as a squared norm, this substitution gives exponent 0.75, not 1.5.', reviewer: 'Orchestrator' });
    assert.equal(JSON.stringify(member), before);
    assert.equal(record.assessmentNotProof, true);
    assert.equal(record.reviewerIdentity, 'SELF_REPORTED');
    assert.match(record.sourceHash, /^[a-f0-9]{64}$/);
    const restored = new StateStore(file).getWorkspace(workspace.id);
    assert.equal(restored.reviewNotes[0].id, record.id);
    assert.equal(researchSnapshots(restored)[0].assessments[0].verdict, 'rejected');
    const beforeInvalid = JSON.stringify(store.state);
    assert.throws(() => store.addReviewNote(workspace.id, { memberId: member.id, messageId: 'missing', verdict: 'rejected', rationale: 'why', reviewer: 'r' }), { code: 'REVIEW_SOURCE_NOT_FOUND' });
    assert.throws(() => store.addReviewNote(workspace.id, { verdict: 'verified', rationale: ' ', reviewer: 'r' }), { code: 'INVALID_REVIEW' });
    assert.equal(JSON.stringify(store.state), beforeInvalid);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
