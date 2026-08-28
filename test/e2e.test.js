import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

describe('e2e deterministic coverage (no external LibreChat)', () => {
  let tmp;
  let store;
  let scheduler;
  let client;
  let failNext = false;

  before(() => {
    tmp = path.join(os.tmpdir(), `mcc-e2e-${Date.now()}.json`);
    store = new StateStore(tmp);
    client = {
      async runAgent({ prompt }) {
        if (failNext) { failNext = false; throw new Error('forced failure'); }
        return { id: `resp_${Date.now()}`, text: `echo:${String(prompt).slice(0,20)}`, usage: {}, conversationId: `conv_${String(prompt).slice(0,5)}` };
      },
      async health() { return { ok: true, mode: 'native', agents: 2, latencyMs: 1 }; },
      async listAgents() { return [{ id: 'a1' }, { id: 'a2' }]; },
    };
    scheduler = new Scheduler({ store, client, maxHistoryMessages: 20 });
  });
  after(() => { try { fs.unlinkSync(tmp); } catch {} });

  it('workspace lifecycle persist and no stale overwrite', async () => {
    const w1 = store.createWorkspace({ name: 'W1' });
    const w2 = store.createWorkspace({ name: 'W2' });
    store.updateWorkspace(w1.id, { name: 'W1-renamed', globalPrompt: 'SystemA' });
    store.save();
    const s2 = new StateStore(tmp);
    assert.equal(s2.getWorkspace(w1.id).name, 'W1-renamed');
    assert.equal(s2.getWorkspace(w1.id).globalPrompt, 'SystemA');
    assert.equal(s2.getWorkspace(w2.id).name, 'W2');
  });

  it('member lifecycle + deactivation guards', async () => {
    const w = store.createWorkspace({ name: 'WM' });
    const m = store.addMember(w.id, { name: 'ChatA', agentId: 'a1', developerPrompt: 'devA' });
    store.updateMember(w.id, m.id, { name: 'ChatA-renamed', developerPrompt: 'devA2', canInspectOthers: false });
    const got = store.getMember(w.id, m.id);
    assert.equal(got.name, 'ChatA-renamed');
    store.updateMember(w.id, m.id, { active: false });
    assert.equal(store.getMember(w.id, m.id).active, false);
    assert.throws(() => store.enqueue(w.id, m.id, 'hello'), (e) => e.status === 409);
    store.updateMember(w.id, m.id, { active: true });
    store.deleteMember(w.id, m.id);
    assert.equal(store.getMember(w.id, m.id), null);
  });

  it('broadcast isolates to active only', async () => {
    const w = store.createWorkspace({ name: 'WC' });
    const a = store.addMember(w.id, { name: 'A', active: true });
    const b = store.addMember(w.id, { name: 'B', active: true });
    const c = store.addMember(w.id, { name: 'C', active: false });
    const items = store.broadcast(w.id, 'hello');
    assert.equal(items.length, 2);
    assert.equal(store.getMember(w.id, a.id).queue.length, 1);
    assert.equal(store.getMember(w.id, c.id).queue.length, 0);
    store.updateMember(w.id, a.id, { active: false });
    store.clearQueues(w.id);
    const items2 = store.broadcast(w.id, 'second');
    assert.equal(items2.length, 1);
  });

  it('direct isolates to one chat', async () => {
    const w = store.createWorkspace({ name: 'WD' });
    const a = store.addMember(w.id, { name: 'A' });
    const b = store.addMember(w.id, { name: 'B' });
    const c = store.addMember(w.id, { name: 'C' });
    store.enqueue(w.id, b.id, 'to B');
    assert.equal(store.getMember(w.id, b.id).queue.length, 1);
    assert.equal(store.getMember(w.id, a.id).queue.length, 0);
    assert.equal(store.getMember(w.id, c.id).queue.length, 0);
  });

  it('FIFO P1->P4 and failure BLOCKED ordering', async () => {
    const w = store.createWorkspace({ name: 'WE' });
    const m = store.addMember(w.id, { name: 'M' });
    store.enqueue(w.id, m.id, 'P1'); store.enqueue(w.id, m.id, 'P2'); store.enqueue(w.id, m.id, 'P3'); store.enqueue(w.id, m.id, 'P4');
    let n = store.beginNext(w.id, m.id); assert.equal(n.item.prompt, 'P1'); store.completeRun(w.id, m.id, n.item.id, { text: 'ok' });
    failNext = true; n = store.beginNext(w.id, m.id); assert.equal(n.item.prompt, 'P2');
    try { await client.runAgent({ prompt: n.item.prompt }); assert.fail('should throw'); } catch (e) { store.failRun(w.id, m.id, n.item.id, e.message, { requeue: true }); }
    const mem = store.getMember(w.id, m.id);
    assert.equal(mem.status, 'error'); assert.equal(mem.queue[0].prompt, 'P2');
    store.retryMember(w.id, m.id);
    n = store.beginNext(w.id, m.id); assert.equal(n.item.prompt, 'P2'); store.completeRun(w.id, m.id, n.item.id, { text: 'ok2' });
    n = store.beginNext(w.id, m.id); assert.equal(n.item.prompt, 'P3'); store.completeRun(w.id, m.id, n.item.id, { text: 'ok3' });
    n = store.beginNext(w.id, m.id); assert.equal(n.item.prompt, 'P4'); store.completeRun(w.id, m.id, n.item.id, { text: 'ok4' });
    assert.equal(store.runtimeState(w.id), 'SETTLED');
  });

  it('parallel across chats vs serial within', async () => {
    const w = store.createWorkspace({ name: 'WF' });
    const m1 = store.addMember(w.id, { name: 'M1' }); const m2 = store.addMember(w.id, { name: 'M2' }); const m3 = store.addMember(w.id, { name: 'M3' });
    const starts = [];
    const orig = client.runAgent;
    client.runAgent = async (arg) => { starts.push(Date.now()); await new Promise(r => setTimeout(r, 80)); return { id: 'r', text: 'ok' }; };
    store.enqueue(w.id, m1.id, 's1'); store.enqueue(w.id, m2.id, 's2'); store.enqueue(w.id, m3.id, 's3');
    const p1 = (async () => { const n = store.beginNext(w.id, m1.id); if (n) { const r = await client.runAgent({ prompt: n.item.prompt }); store.completeRun(w.id, m1.id, n.item.id, r); } })();
    const p2 = (async () => { const n = store.beginNext(w.id, m2.id); if (n) { const r = await client.runAgent({ prompt: n.item.prompt }); store.completeRun(w.id, m2.id, n.item.id, r); } })();
    const p3 = (async () => { const n = store.beginNext(w.id, m3.id); if (n) { const r = await client.runAgent({ prompt: n.item.prompt }); store.completeRun(w.id, m3.id, n.item.id, r); } })();
    await Promise.all([p1, p2, p3]);
    assert.ok(Math.max(...starts) - Math.min(...starts) < 50, 'parallel start');
    client.runAgent = orig;
    store.enqueue(w.id, m1.id, 'S1'); store.enqueue(w.id, m1.id, 'S2');
    const n1 = store.beginNext(w.id, m1.id); assert.equal(n1.item.prompt, 'S1');
    const n2 = store.beginNext(w.id, m1.id); assert.equal(n2, null);
    store.completeRun(w.id, m1.id, n1.item.id, { text: 'ok' });
    const n3 = store.beginNext(w.id, m1.id); assert.equal(n3.item.prompt, 'S2'); store.completeRun(w.id, m1.id, n3.item.id, { text: 'ok' });
  });

  it('runtime states and Stop late suppression', async () => {
    const w = store.createWorkspace({ name: 'WG' }); const m = store.addMember(w.id, { name: 'M' });
    assert.equal(store.runtimeState(w.id), 'SETTLED');
    store.enqueue(w.id, m.id, 'q1'); assert.equal(store.runtimeState(w.id), 'PENDING');
    const n = store.beginNext(w.id, m.id); assert.equal(store.runtimeState(w.id), 'RUNNING');
    store.failRun(w.id, m.id, n.item.id, 'fail', { requeue: true }); assert.equal(store.runtimeState(w.id), 'BLOCKED');
    store.retryMember(w.id, m.id); assert.equal(store.runtimeState(w.id), 'PENDING');
    const n2 = store.beginNext(w.id, m.id); store.completeRun(w.id, m.id, n2.item.id, { text: 'ok' }); assert.equal(store.runtimeState(w.id), 'SETTLED');
    // Stop late suppression
    store.enqueue(w.id, m.id, 'will stop'); const nn = store.beginNext(w.id, m.id);
    store.cancelCurrent(w.id, m.id, { clearQueue: true });
    assert.equal(store.completeRun(w.id, m.id, nn.item.id, { text: 'late' }), false);
  });

  it('crash recovery requeues current front', async () => {
    const w = store.createWorkspace({ name: 'WJ' }); const m = store.addMember(w.id, { name: 'M' });
    store.enqueue(w.id, m.id, 'P1'); store.enqueue(w.id, m.id, 'P2'); const n = store.beginNext(w.id, m.id); store.save();
    const s2 = new StateStore(tmp);
    const m2 = s2.getMember(w.id, m.id);
    assert.equal(m2.current, null); assert.equal(m2.queue[0].prompt, 'P1'); assert.equal(m2.queue[1].prompt, 'P2');
  });

  it('compile isolation and private field stripping', async () => {
    const w = store.createWorkspace({ name: 'WCmp' }); const a = store.addMember(w.id, { name: 'A' });
    store.enqueue(w.id, a.id, 'hi'); const n = store.beginNext(w.id, a.id); store.completeRun(w.id, a.id, n.item.id, { text: 'hello' });
    const before = JSON.stringify(store.getMember(w.id, a.id).messages);
    store.setCompile(w.id, { text: 'compiled', responseId: 'r', usage: {} });
    const after = JSON.stringify(store.getMember(w.id, a.id).messages);
    assert.equal(before, after, 'compile must not mutate member histories');
    const { createApp } = await import('../src/server.js');
    const { StateStore: SS } = await import('../src/store.js');
    const tmp2 = path.join(os.tmpdir(), `mcc-e2e2-${Date.now()}.json`);
    const s = new SS(tmp2);
    const ww = s.createWorkspace({ name: 'W' }); s.addMember(ww.id, { name: 'M' });
    const app = createApp({ store: s, client: { health: async () => ({ ok: true, mode: 'native', agents: 0, latencyMs: 0 }), listAgents: async () => [] }, scheduler: { runningMemberIds: () => new Set(), kickMember: () => {}, kickWorkspace: () => {}, stopMember: () => {}, stopWorkspace: () => {}, resumeAll: () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const addr = app.server.address();
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const r = await fetch(`${base}/api/workspaces`);
      const j = await r.json();
      const listed = j.workspaces.find(x => x.id === ww.id);
      assert.ok(listed.runtimeState);
      assert.ok(!JSON.stringify(listed).includes('conversationId'));
      assert.ok(!JSON.stringify(listed).includes('"current"'));
    } finally { await new Promise(r => app.server.close(r)); try { fs.unlinkSync(tmp2); } catch {} }
  });

  it('cross-chat target validation', async () => {
    const w = store.createWorkspace({ name: 'WX' });
    const a = store.addMember(w.id, { name: 'ChatA', active: true });
    const b = store.addMember(w.id, { name: 'ChatB', active: true });
    // duplicate name
    store.addMember(w.id, { name: 'Dup' }); store.addMember(w.id, { name: 'Dup' });
    assert.throws(() => store.resolveMember(w.id, 'Dup'), (e) => e.status === 409);
    assert.throws(() => store.resolveMember(w.id, 'nonexistent'), (e) => e.status === 404);
    const mInactive = store.addMember(w.id, { name: 'Inactive', active: false });
    assert.throws(() => store.resolveMember(w.id, mInactive.id, { activeOnly: true }), (e) => e.status === 409);
  });
});
