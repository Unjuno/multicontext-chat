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
  it('app.js uses shared runtime label module with normalization', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    // app.js should import shared module (single source of truth) or directly normalize
    const usesShared = src.includes("from './runtimeLabels.js'") && src.includes('sharedWorkspaceLabel');
    const directNorm = /String\(state[\s\S]*?toLowerCase\(\)/.test(src);
    assert.ok(usesShared || directNorm, 'app.js must use shared runtimeLabels or normalize with toLowerCase');
    const sharedSrc = fs.readFileSync(new URL('../public/runtimeLabels.js', import.meta.url), 'utf8');
    assert.match(sharedSrc, /toLowerCase\(\)/, 'shared runtimeLabels must normalize with toLowerCase');
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

describe('draft preservation and guards', () => {
  it('app.js has draft-preserving refresh helper', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(src, /refreshPreservingDrafts/, 'must have refreshPreservingDrafts helper');
    assert.match(src, /snapshotFormState/, 'must snapshot form');
    assert.match(src, /snapshotScrollPositions/, 'must snapshot scroll');
  });
  it('app.js guards workspace switch with dirty check', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(src, /isWorkspaceDirty/, 'must have isWorkspaceDirty');
    assert.match(src, /未保存の変更があります。破棄して別のワークスペースに移動しますか？/, 'must prompt on dirty switch');
  });
  it('app.js has duplicate-submit guard via withBusy', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(src, /withBusy/, 'must have withBusy');
    assert.match(src, /btn\.disabled \|\| btn\.classList\.contains\('is-busy'\)/, 'withBusy must guard duplicate');
  });
  it('app.js no longer has overly broad aria-live on #app', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<section id="app"[^>]*aria-live/, '#app must not have aria-live');
    assert.match(html, /aria-live="polite"/, 'targeted live regions must remain');
  });
  it('workspace list uses correct semantics (div listitem > button)', () => {
    const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(src, /<div role="listitem"><button class="workspace-link/, 'list must be div listitem > button');
    assert.doesNotMatch(src, /role="listitem"[^>]*class="workspace-link"/, 'button must not have role listitem');
    assert.match(src, /aria-current/, 'active workspace should have aria-current');
  });
  it('help cursor misuse removed', () => {
    const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /\*\[title\]:hover\s*\{\s*cursor:\s*help/, 'must not have global help cursor');
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
