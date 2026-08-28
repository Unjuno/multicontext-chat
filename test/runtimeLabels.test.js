import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceStatusLabel, memberStatusLabel } from '../src/runtimeLabels.js';
import fs from 'node:fs';

describe('workspace runtime label contract', () => {
  const cases = [
    ['RUNNING', 'RUNNING · 実行中', 'running'],
    ['running', 'RUNNING · 実行中', 'running'],
    ['PENDING', 'PENDING · キューあり', 'pending'],
    ['pending', 'PENDING · キューあり', 'pending'],
    ['BLOCKED', 'BLOCKED · 要対応', 'blocked'],
    ['blocked', 'BLOCKED · 要対応', 'blocked'],
    ['SETTLED', 'SETTLED · 処理待ちなし', 'settled'],
    ['settled', 'SETTLED · 処理待ちなし', 'settled'],
  ];
  for (const [input, expectedLabel, expectedCls] of cases) {
    it(`${input} -> label "${expectedLabel}" class "${expectedCls}"`, () => {
      const { label, cls } = workspaceStatusLabel(input);
      assert.equal(label, expectedLabel);
      assert.equal(cls, expectedCls);
    });
  }
  it('error maps to BLOCKED · 要対応 / blocked', () => {
    const { label, cls } = workspaceStatusLabel('error');
    assert.equal(label, 'BLOCKED · 要対応');
    assert.equal(cls, 'blocked');
  });
  it('normalizes case for CSS class (no uppercase class)', () => {
    for (const state of ['RUNNING','PENDING','BLOCKED','SETTLED']) {
      const { cls } = workspaceStatusLabel(state);
      assert.equal(cls, cls.toLowerCase(), `cls should be lowercase for ${state}`);
      assert.notEqual(cls, state, 'class must not be uppercase');
    }
  });
  it('app.js workspaceStatusLabel normalizes via toLowerCase', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(src, /String\(state[\s\S]*?toLowerCase\(\)/, 'app.js must normalize state with toLowerCase');
    assert.match(src, /const normalized = String\(state/, 'app.js must use normalized variable');
  });
});

describe('member status label contract', () => {
  it('running -> 実行中', () => assert.equal(memberStatusLabel('running').label, '実行中'));
  it('RUNNING case-insensitive -> 実行中', () => assert.equal(memberStatusLabel('RUNNING').label, '実行中'));
  it('idle -> 待機', () => assert.equal(memberStatusLabel('idle').label, '待機'));
  it('error -> ブロック中 / blocked', () => {
    const r = memberStatusLabel('error');
    assert.equal(r.label, 'ブロック中');
    assert.equal(r.cls, 'blocked');
  });
});

describe('workspace list does not leak private fields but exposes runtimeState', async () => {
  it('listWorkspaces response contract', async () => {
    const { createApp } = await import('../src/server.js');
    const { StateStore } = await import('../src/store.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `mcc-test-${Date.now()}.json`);
    const store = new StateStore(tmp);
    const ws = store.createWorkspace({ name: 'WS' });
    store.addMember(ws.id, { name: 'A' });
    const app = createApp({ store, client: { health: async () => ({ ok: true, mode: 'native', agents: 0, latencyMs: 0 }), listAgents: async () => [] }, scheduler: { runningMemberIds: () => new Set(), kickMember: () => {}, kickWorkspace: () => {}, stopMember: () => {}, stopWorkspace: () => {}, resumeAll: () => {} } });
    // start ephemeral server
    await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
    const addr = app.server.address();
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const resp = await fetch(`${base}/api/workspaces`);
      const data = await resp.json();
      const listed = data.workspaces.find((w) => w.id === ws.id);
      assert.ok(listed, 'workspace should be listed');
      assert.equal(listed.runtimeState, 'SETTLED');
      assert.equal(listed.settled, true);
      // must not expose private internals
      const raw = JSON.stringify(listed);
      assert.doesNotMatch(raw, /conversationId/);
      assert.doesNotMatch(raw, /"current"/);
      assert.doesNotMatch(raw, /"lastRun"/);
    } finally {
      await new Promise((res) => app.server.close(res));
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
});
