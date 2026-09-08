import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { _internalQStore, PRESETS } from '../src/mcp/orchestrator.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-orch-')), 'state.json'));
const makeApp = () => {
  const store = makeStore();
  const client = { listAgents: async () => [{ id: 'a', name: 'A' }], health: async () => ({ ok: true }) };
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  const app = createApplication({ config: { mcpEnabled: false, mcpToken: '' }, store, client, scheduler });
  scheduler.setApp(app);
  return { store, app };
};

test('orchestrator Q priority ordering', async () => {
  const { store } = makeApp();
  const { pushQ, popQ } = await import('../src/mcp/orchestrator.js');
  const ws = store.createWorkspace({ name: 'W' });
  _internalQStore().delete(ws.id);
  const q1 = pushQ(ws.id, 'low', 2);
  const q2 = pushQ(ws.id, 'high', 0);
  const q3 = pushQ(ws.id, 'mid', 1);
  const peek = _internalQStore().get(ws.id);
  assert.equal(peek[0].prompt, 'high');
  assert.equal(peek[1].prompt, 'mid');
  assert.equal(peek[2].prompt, 'low');
  const popped = popQ(ws.id);
  assert.equal(popped.prompt, 'high');
});

test('orchestrator create_session preset creates 4 members', async () => {
  assert.equal(PRESETS['navier-stokes-4'].members.length, 4);
  assert.ok(PRESETS['navier-stokes-4'].members[0].developerPrompt.includes('PDE'));
  assert.equal(PRESETS['navier-stokes-adversarial-4'].members.length, 4);
  assert.deepEqual(PRESETS['navier-stokes-adversarial-4'].members.map((m) => m.name), [
    'A — Harmonic Analyst', 'B — Numerical Skeptic', 'C — Blow-up Hunter', 'D — Proof Auditor',
  ]);
  assert.deepEqual(PRESETS['navier-stokes-proof-builder-4'].members.map((m) => m.name), [
    'A — Lemma Architect', 'B — Energy Method', 'C — Critical Spaces', 'D — Proof Verifier',
  ]);
  assert.deepEqual(PRESETS['navier-stokes-geometric-4'].members.map((m) => m.name), [
    'A — Geometric Measure Analyst', 'B — Harmonic Analyst', 'C — Computer-Assisted Skeptic', 'D — Adversarial Auditor',
  ]);
  assert.match(PRESETS['navier-stokes-geometric-4'].seedPrompt, /THEOREM/);
  assert.deepEqual(PRESETS['evidence-obligation-4'].members.map((m) => m.name), [
    'A — Claim Formalizer', 'B — Source Auditor', 'C — Falsification Checker', 'D — Integration Auditor',
  ]);
  assert.match(PRESETS['evidence-obligation-4'].seedPrompt, /Phase 1 only/);
  assert.match(PRESETS['evidence-obligation-4'].seedPrompt, /separate audit phase/);
  assert.match(PRESETS['evidence-obligation-4'].members[2].developerPrompt, /actual returned values/);
  assert.match(PRESETS['evidence-obligation-4'].members[0].developerPrompt, /Do not list tautological definition checks/);
  assert.match(PRESETS['evidence-obligation-4'].members[1].developerPrompt, /at most three searches/);
  assert.match(PRESETS['evidence-obligation-4'].members[2].developerPrompt, /check every domain hypothesis/);
  assert.match(PRESETS['evidence-obligation-4'].members[3].developerPrompt, /without calling any peer tool/);
});

test('orchestrator distill truncates', async () => {
  const { store, app } = makeApp();
  const ws = store.createWorkspace({ name: 'W' });
  const m = store.addMember(ws.id, { name: 'A' });
  // add a completed message so getChatMessages returns it
  store.enqueue(ws.id, m.id, 'hello');
  const p = store.beginNext(ws.id, m.id);
  store.completeRun(ws.id, m.id, p.item.id, { id: 'r1', text: 'world' });
  const msgs = await app.getChatMessages(ws.id, m.id, { limit: 5 });
  assert.ok(msgs.length >= 1);
});
