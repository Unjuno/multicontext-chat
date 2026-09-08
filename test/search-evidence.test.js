import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchEvidence, recordSearchEvidence } from '../src/search-evidence.js';
import { searchEvidenceLabel } from '../public/search-evidence.js';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { researchSnapshots } from '../src/research-summary.js';

test('search evidence counts actual outcomes, stays bounded, and does not certify full text', () => {
  const e = createSearchEvidence();
  for (let i = 0; i < 12; i++) {
    const output = i < 2 ? { ok: false } : i < 4 ? { ok: true, results: [] }
      : { ok: true, results: [{}], source: 'Crossref', fullTextVerified: true };
    recordSearchEvidence(e, [{ name: 'search_sources', call_id: String(i) }], [{ call_id: String(i), output: JSON.stringify(output) }]);
  }
  recordSearchEvidence(e, [{ name: 'send_to_chat', call_id: 'not-search' }], [{ call_id: 'not-search', output: '{"ok":true,"results":[{}]}' }]);
  assert.equal(e.attempted, 12);
  assert.deepEqual([e.succeeded, e.empty, e.failed], [8, 2, 2]);
  assert.equal(e.calls.length, 8);
  assert.equal(e.omittedCalls, 4);
  assert.equal(e.fullTextVerified, false);
  assert.ok(e.calls.every(c => c.fullTextVerified === false));
  assert.match(searchEvidenceLabel(e), /結果あり 8回/);
  assert.match(searchEvidenceLabel(undefined), /旧履歴/);
  assert.match(searchEvidenceLabel(createSearchEvidence()), /過去履歴・外部検索は対象外/);
});

test('scheduler records search separately from model claims and retains it for synthesis/restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-search-evidence-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    const w = store.createWorkspace();
    const member = store.addMember(w.id, { name: 'Researcher', agentId: 'model' });
    const client = { mode: 'native', listAgents: async () => [{ id: 'model' }],
      runAgent: async ({ prompt }) => prompt === 'search' ? { raw: { output: [{ type: 'function_call', name: 'search_sources', call_id: 'search1', arguments: '{"query":"test","source":"papers"}' }] } }
        : { text: 'I verified the paper with a fresh search.', searchEvidence: { succeeded: 99 }, toolEvidence: { attempted: 99 } },
      continueAgent: async () => ({ text: 'I found source metadata.' }) };
    const scheduler = new Scheduler({ store, client });
    const app = createApplication({ config: {}, store, client, scheduler });
    scheduler.setApp(app);
    scheduler.executor.search = { search: async () => ({ ok: true, results: [{ title: 'Paper' }], source: 'Crossref', evidenceType: 'scholarly_metadata' }) };
    for (const prompt of ['search', 'claim-only']) {
      await app.send(w.id, member.id, prompt);
      while (scheduler.running.size) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const messages = new StateStore(file).getMember(w.id, member.id).messages.filter(m => m.role === 'assistant');
    assert.equal(messages[0].searchEvidence.succeeded, 1);
    assert.equal(messages[0].searchEvidence.calls[0].callId, 'search1');
    assert.equal(messages[0].toolEvidence.attempted, 1);
    assert.equal(messages[0].toolEvidence.calls[0].tool, 'search_sources');
    assert.equal(messages[1].searchEvidence.attempted, 0, 'model prose and supplied metadata must not forge runtime evidence');
    assert.equal(messages[1].toolEvidence.attempted, 0, 'model-supplied tool evidence must not be trusted');
    const snapshot = researchSnapshots(store.getWorkspace(w.id))[0];
    assert.deepEqual(snapshot.messages.filter(m => m.role === 'assistant').map(m => m.searchEvidence.succeeded), [1, 0]);
    assert.deepEqual(snapshot.messages.filter(m => m.role === 'assistant').map(m => m.toolEvidence.attempted), [1, 0]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
