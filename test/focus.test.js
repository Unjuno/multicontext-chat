import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-focus-')), 'state.json'));
const makeConfig = (overrides = {}) => ({
  dataFile: '/unused/state.json', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://librechat', librechatApiKey: 'key', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  ...overrides,
});
const inertClient = {
  health: async () => ({ ok: true, agents: 0, mode: 'compat' }),
  listAgents: async () => [],
};

async function withServer(fn) {
  const store = makeStore();
  const scheduler = new Scheduler({ store, client: inertClient, maxHistoryMessages: 50 });
  const app = createApp({ config: makeConfig(), store, client: inertClient, scheduler });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { await fn({ ...app, base, store }); }
  finally { await new Promise((resolve) => app.server.close(resolve)); }
}

test('focus hint is set per workspace and consumed exactly once', async () => {
  await withServer(async ({ base, store }) => {
    const ws = store.createWorkspace({ name: 'W' });
    // nothing pending initially
    let r = await fetch(`${base}/api/focus/pending`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).focus, null);
    // unknown workspace: 404, nothing stored
    r = await fetch(`${base}/api/workspaces/nope/focus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 404);
    // set with run + reason
    r = await fetch(`${base}/api/workspaces/${ws.id}/focus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-1', reason: 'mcp-experiment-start' }),
    });
    assert.equal(r.status, 200);
    const set = await r.json();
    assert.equal(set.ok, true);
    assert.equal(set.focus.workspace_id, ws.id);
    assert.equal(set.focus.run_id, 'run-1');
    // first consume returns it
    r = await fetch(`${base}/api/focus/pending`);
    assert.deepEqual((await r.json()).focus.workspace_id, ws.id);
    // second consume is empty (exactly once)
    r = await fetch(`${base}/api/focus/pending`);
    assert.deepEqual((await r.json()).focus, null);
  });
});

test('focus hint never persists into workspace state', async () => {
  await withServer(async ({ base, store }) => {
    const ws = store.createWorkspace({ name: 'W' });
    await fetch(`${base}/api/workspaces/${ws.id}/focus`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    assert.equal(JSON.stringify(raw).includes('pendingFocus'), false);
    assert.equal('pendingFocus' in store.state, false);
  });
});
