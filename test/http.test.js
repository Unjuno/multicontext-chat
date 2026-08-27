import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-http-')), 'state.json'));
const makeConfig = (overrides = {}) => ({
  dataFile: '/unused/state.json', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://librechat', librechatApiKey: 'key', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  ...overrides,
});

async function withServer(client, fn, configOverrides = {}) {
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const app = createApp({ config: makeConfig(configOverrides), store, client, scheduler });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try { await fn({ ...app, base }); }
  finally { await new Promise((resolve) => app.server.close(resolve)); }
}

async function jsonRequest(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function waitForSettled(base, workspaceId, timeoutMs = 1000) {
  const started = Date.now();
  while (true) {
    const { data } = await jsonRequest(base, `/api/workspaces/${workspaceId}`);
    if (data.runtimeState === 'SETTLED' || data.runtimeState === 'BLOCKED') return data;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for runtime state');
    await sleep(10);
  }
}

test('HTTP broadcast runs active chats and returns SETTLED after queues drain', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 2, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    runAgent: async ({ agentId, prompt }) => ({ id: `r-${agentId}`, text: `${agentId}:${prompt}` }),
  };
  await withServer(client, async ({ base }) => {
    let result = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
    const workspaceId = result.data.id;
    await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'a' }) });
    await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'B', agentId: 'b' }) });
    result = await jsonRequest(base, `/api/workspaces/${workspaceId}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) });
    assert.equal(result.response.status, 202);
    const settled = await waitForSettled(base, workspaceId);
    assert.equal(settled.runtimeState, 'SETTLED');
    const assistants = Object.values(settled.members).flatMap((member) => member.messages.filter((message) => message.role === 'assistant').map((message) => message.content));
    assert.deepEqual(new Set(assistants), new Set(['a:hello', 'b:hello']));
  });
});

test('Compile is rejected while running and succeeds only after SETTLED', async () => {
  let release;
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async ({ prompt, metadata }) => {
      if (metadata?.purpose === 'compile') return { id: 'compile', text: 'compiled' };
      if (prompt === 'slow') await new Promise((resolve) => { release = resolve; });
      return { id: 'run', text: 'done' };
    },
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ compilePrompt: 'Summarize.' }) });
    const workspaceId = created.data.id;
    const added = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'a' }) });
    const memberId = added.data.member.id;
    await jsonRequest(base, `/api/workspaces/${workspaceId}/members/${memberId}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'slow' }) });
    for (let i = 0; i < 100 && !release; i += 1) await sleep(5);
    assert.ok(release, 'run should have started');
    let compiled = await jsonRequest(base, `/api/workspaces/${workspaceId}/compile`, { method: 'POST', body: '{}' });
    assert.equal(compiled.response.status, 409);
    release();
    await waitForSettled(base, workspaceId);
    compiled = await jsonRequest(base, `/api/workspaces/${workspaceId}/compile`, { method: 'POST', body: '{}' });
    assert.equal(compiled.response.status, 200);
    assert.equal(compiled.data.lastCompile.text, 'compiled');
  });
});

test('cross-chat Action lists peers and queues the same prompt to one or two peers', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 3, mode: 'compat' }),
    listAgents: async () => [],
    runAgent: async ({ agentId, prompt }) => ({ id: `r-${agentId}`, text: `${agentId}:${prompt}` }),
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: '{}' });
    const workspaceId = created.data.id;
    const members = [];
    for (const [name, agentId] of [['A', 'a'], ['B', 'b'], ['C', 'c']]) {
      const added = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name, agentId }) });
      members.push(added.data.member);
    }
    const [a, b, c] = members;
    let peers = await jsonRequest(base, `/tools/${workspaceId}/${a.id}/list-chats`);
    assert.deepEqual(new Set(peers.data.chats.map((chat) => chat.name)), new Set(['B', 'C']));

    const sent = await jsonRequest(base, `/tools/${workspaceId}/${a.id}/send-to-chat`, {
      method: 'POST', body: JSON.stringify({ targets: ['B', c.id], prompt: 'check this' }),
    });
    assert.equal(sent.response.status, 202);
    assert.equal(sent.data.deliveries.length, 2);
    const settled = await waitForSettled(base, workspaceId);
    assert.equal(settled.members[b.id].messages.some((message) => message.content === 'check this'), true);
    assert.equal(settled.members[c.id].messages.some((message) => message.content === 'check this'), true);
  });
});

test('Action public URL uses configured externally reachable origin', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 0, mode: 'compat' }),
    listAgents: async () => [],
    runAgent: async () => ({ id: 'r', text: 'ok' }),
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({}) });
    const workspaceId = created.data.id;
    const added = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'a' }) });
    const memberId = added.data.member.id;
    const view = await jsonRequest(base, `/api/workspaces/${workspaceId}`);
    assert.equal(view.data.members[memberId].actionSpecUrl, `https://multicontext.example/tools/${workspaceId}/${memberId}/openapi.json`);
  }, { publicUrl: 'https://multicontext.example' });
});

test('malformed percent-encoding in a static path returns 404 instead of crashing', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 0, mode: 'compat' }),
    listAgents: async () => [],
    runAgent: async () => ({ id: 'r', text: 'ok' }),
  };
  await withServer(client, async ({ base }) => {
    const response = await fetch(`${base}/%zz`);
    assert.equal(response.status, 404);
  });
});

test('public workspace view strips internal fields and exposes inFlight boolean', async () => {
  let release;
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async ({ prompt }) => {
      if (prompt === 'slow') await new Promise((resolve) => { release = resolve; });
      return { id: 'run', text: 'done' };
    },
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({}) });
    const workspaceId = created.data.id;
    const added = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'a' }) });
    const memberId = added.data.member.id;
    // Enqueue a slow prompt so the member is in-flight
    await jsonRequest(base, `/api/workspaces/${workspaceId}/members/${memberId}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'slow' }) });
    for (let i = 0; i < 100 && !release; i += 1) await sleep(5);
    assert.ok(release, 'run should have started');
    // Check the public view while in-flight
    const view = await jsonRequest(base, `/api/workspaces/${workspaceId}`);
    const member = view.data.members[memberId];
    assert.equal(member.inFlight, true, 'inFlight should be true while running');
    assert.equal(member.current, undefined, 'current should not be exposed');
    assert.equal(member.conversationId, undefined, 'conversationId should not be exposed');
    assert.equal(member.lastRun, undefined, 'lastRun should not be exposed');
    release();
    await waitForSettled(base, workspaceId);
    // Check the public view after settling
    const settled = await jsonRequest(base, `/api/workspaces/${workspaceId}`);
    const settledMember = settled.data.members[memberId];
    assert.equal(settledMember.inFlight, false, 'inFlight should be false when settled');
  });
});

test('list workspaces and addMember responses also strip internal fields', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async () => ({ id: 'r', text: 'hi' }),
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: '{}' });
    const workspaceId = created.data.id;
    const addRes = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'X', agentId: 'a' }) });
    const added = addRes.data.member;
    assert.equal(added.conversationId, undefined, 'addMember response: no conversationId');
    assert.equal(added.current, undefined, 'addMember response: no current');
    assert.equal(added.lastRun, undefined, 'addMember response: no lastRun');
    assert.equal(typeof added.inFlight, 'boolean', 'addMember response: inFlight is boolean');
    const list = await jsonRequest(base, '/api/workspaces');
    const listed = list.data.workspaces.find((w) => w.id === workspaceId);
    const lm = Object.values(listed.members)[0];
    assert.equal(lm.conversationId, undefined, 'list workspaces: no conversationId');
    assert.equal(lm.current, undefined, 'list workspaces: no current');
    assert.equal(lm.lastRun, undefined, 'list workspaces: no lastRun');
    assert.equal(typeof lm.inFlight, 'boolean', 'list workspaces: inFlight is boolean');
  });
});

test('concurrent compile requests are rejected while one compile is already running', async () => {
  let releaseCompile;
  let compileCalls = 0;
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async ({ metadata }) => {
      if (metadata?.purpose === 'compile') {
        compileCalls += 1;
        await new Promise((resolve) => { releaseCompile = resolve; });
        return { id: 'compile', text: 'compiled' };
      }
      return { id: 'run', text: 'done' };
    },
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: '{}' });
    const workspaceId = created.data.id;
    await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'a' }) });
    const first = jsonRequest(base, `/api/workspaces/${workspaceId}/compile`, { method: 'POST', body: '{}' });
    for (let i = 0; i < 100 && !releaseCompile; i += 1) await sleep(5);
    const second = await jsonRequest(base, `/api/workspaces/${workspaceId}/compile`, { method: 'POST', body: '{}' });
    assert.equal(second.response.status, 409);
    releaseCompile();
    const done = await first;
    assert.equal(done.response.status, 200);
    assert.equal(compileCalls, 1);
  });
});

test('OpenAPI spec includes error responses for all operations', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [{ id: 'a', name: 'A' }],
    runAgent: async () => ({ id: 'r', text: 'hi' }),
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: '{}' });
    const workspaceId = created.data.id;
    const addRes = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'X', agentId: 'a' }) });
    const memberId = Object.keys(addRes.data.workspace.members)[0];
    const specRes = await jsonRequest(base, `/tools/${workspaceId}/${memberId}/openapi.json`);
    const spec = specRes.data;
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (typeof op !== 'object' || !op.responses) continue;
        assert.ok(op.responses['400'], `${method} ${pathKey} missing 400`);
        assert.ok(op.responses['401'], `${method} ${pathKey} missing 401`);
        assert.ok(op.responses['403'], `${method} ${pathKey} missing 403`);
        assert.ok(op.responses['404'], `${method} ${pathKey} missing 404`);
      }
    }
    const sendOp = Object.values(spec.paths).find((p) => p.post?.operationId === 'send_to_chat')?.post;
    assert.ok(sendOp, 'send-to-chat operation not found');
    assert.ok(sendOp.responses['409'], 'send-to-chat missing 409');
  });
});

test('publicOrigin rejects non-http/https forwarded proto', async () => {
  const client = {
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    listAgents: async () => [],
    runAgent: async () => ({ id: 'r', text: '' }),
  };
  await withServer(client, async ({ base }) => {
    const created = await jsonRequest(base, '/api/workspaces', { method: 'POST', body: '{}' });
    const workspaceId = created.data.id;
    const addRes = await jsonRequest(base, `/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ name: 'X', agentId: 'a' }) });
    const memberId = Object.keys(addRes.data.workspace.members)[0];
    const specRes = await jsonRequest(base, `/tools/${workspaceId}/${memberId}/openapi.json`);
    const origin = specRes.data.servers[0].url;
    assert.ok(origin.startsWith('http://') || origin.startsWith('https://'), `origin should be http(s), got: ${origin}`);
  });
});
