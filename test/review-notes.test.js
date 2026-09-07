import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { researchSnapshots } from '../src/research-summary.js';

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
