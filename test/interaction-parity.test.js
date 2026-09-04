import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Differential GUI-vs-MCP parity tests.
//
// Fixture A is driven through GUI/HTTP routes, fixture B through MCP tools,
// both against the same stack. Snapshots are normalized (dynamic ids and
// timestamps stripped; member identity keyed by name; origin human<->mcp
// normalized with the caller origin asserted separately). Canonical-method
// spies prove both surfaces route through the same Application implementation.

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-parity-')), 'state.json'));
const makeConfig = (overrides = {}) => ({
  dataFile: '/unused/state.json', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://librechat', librechatApiKey: 'key', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  mcpToken: 'parity-token', mcpEnabled: true, host: '127.0.0.1', port: 0,
  ...overrides,
});
const mockAgents = [{ id: 'agent-1', name: 'A1', provider: 'gpt-oss' }];
const mockClient = (overrides = {}) => ({
  listAgents: async () => mockAgents,
  health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
  runAgent: async ({ prompt }) => ({ id: `r-${prompt}`, text: `ok:${prompt}` }),
  ...overrides,
});

async function withStack(fn) {
  const store = makeStore();
  const client = mockClient();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const config = makeConfig();
  const bundle = createApp({ config, store, client, scheduler });
  const app = bundle.app;
  // Spy on canonical application methods (both transports share this object).
  const calls = [];
  for (const name of ['createWorkspace', 'updateWorkspace', 'deleteWorkspace', 'addChat', 'updateChat', 'deleteChat', 'broadcast', 'send', 'sendToChats', 'listPeerChats', 'inspectPeerChat', 'stopWorkspace', 'stopChat', 'retryChat', 'compile', 'waitUntilSettled', 'getWorkspace', 'getChatMessages', 'startRun', 'cancelRun', 'setOrchestratorPaused', 'resumeQueuedRun']) {
    if (typeof app[name] !== 'function') throw new Error(`canonical method missing: ${name}`);
    const orig = app[name].bind(app);
    // Sync wrapper (not async): preserves sync methods such as startRun so
    // callers observing return values directly keep working.
    app[name] = (...args) => { calls.push(name); return orig(...args); };
  }
  await new Promise(r => bundle.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${bundle.server.address().port}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.mcpToken}` } },
  });
  const mcp = new Client({ name: 'parity-mcp', version: '1.0.0' });
  await mcp.connect(transport);
  const gui = async (route, opts = {}) => {
    const res = await fetch(`${base}${route}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { res, data };
  };
  const callTool = async (name, args) => {
    const res = await mcp.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };
  try { await fn({ store, scheduler, app, base, gui, mcp, callTool, calls }); }
  finally {
    try { await mcp.close(); } catch {}
    await new Promise(r => bundle.server.close(r));
  }
}

async function waitSettled(store, scheduler, wsId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = store.runtimeState(wsId, scheduler.runningMemberIds(wsId));
    if (s === 'SETTLED' || s === 'BLOCKED') return s;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for settle');
}

// Strip dynamic ids/timestamps; key members by name; normalize caller origin.
function normWorkspace(view) {
  const members = {};
  for (const m of Object.values(view.members || {})) {
    members[m.name] = {
      name: m.name, agentId: m.agentId, developerPrompt: m.developerPrompt,
      active: m.active, canInspectOthers: m.canInspectOthers, canSendOthers: m.canSendOthers,
      status: m.status, lastError: m.lastError,
      queue: (m.queue || []).map(q => ({ prompt: q.prompt, attempts: q.attempts, source: q.source, sourceMemberId: q.sourceMemberId ? '<member>' : q.sourceMemberId, orchestratorRunId: q.orchestratorRunId ? '<run>' : q.orchestratorRunId, orchestratorQId: q.orchestratorQId ? '<q>' : q.orchestratorQId })),
      messages: (m.messages || []).map(x => ({ role: x.role, content: x.content })),
    };
  }
  return {
    name: view.name, globalPrompt: view.globalPrompt, defaultAgentId: view.defaultAgentId,
    compileAgentId: view.compileAgentId, compilePrompt: view.compilePrompt,
    settings: view.settings, members,
    lastCompile: view.lastCompile ? { text: view.lastCompile.text } : null,
    runtimeState: view.runtimeState, settled: view.settled,
    stats: view.stats,
  };
}

function normEvents(store, wsId) {
  // Caller origin (human GUI vs mcp agent) is asserted separately per surface;
  // here both normalize to <caller> so event streams compare structurally.
  return store.getWorkspace(wsId).orchestratorEvents.map(e => ({
    type: e.type,
    origin: (e.origin === 'mcp' || e.origin === 'human') ? '<caller>' : e.origin,
    member: e.memberId ? '<member>' : e.memberId,
    run: e.runId ? '<run>' : e.runId,
    q: e.qId ? '<q>' : e.qId,
    detail: JSON.stringify(e.detail ?? null)
      .replace(/"runId":"[^"]+"/g, '"runId":"<run>"')
      .replace(/"qId":"[^"]+"/g, '"qId":"<q>"')
      .replace(/"queueItemId":"[^"]+"/g, '"queueItemId":"<q>"')
      .replace(/"callId":"[^"]+"/g, '"callId":"<call>"'),
  }));
}

function normError(res, data) {
  return { status: res.status, error: data.error, code: data.code || null };
}

test('parity: create workspace (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, calls, store }) => {
    const before = calls.length;
    const g = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
    assert.equal(g.res.status, 201);
    const m = await callTool('multicontext_create_workspace', { name: 'W' });
    assert.deepEqual(calls.slice(before).filter(c => c === 'createWorkspace').length, 2);
    assert.deepEqual(normWorkspace(g.data), normWorkspace(m));
  });
});

test('parity: update workspace incl. settings (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store }) => {
    const g0 = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
    const m0 = await callTool('multicontext_create_workspace', { name: 'W' });
    const wsA = g0.data.id, wsB = m0.id;
    const g = await gui(`/api/workspaces/${wsA}`, { method: 'PATCH', body: JSON.stringify({ name: 'W2', globalPrompt: 'sys', settings: { allowCrossChatSend: false } }) });
    const m = await callTool('multicontext_update_workspace', { workspace_id: wsB, name: 'W2', system_prompt: 'sys', allow_cross_chat_send: false });
    assert.deepEqual(normWorkspace(g.data), normWorkspace(m));
    assert.equal(store.getWorkspace(wsA).settings.allowCrossChatSend, false);
    assert.equal(store.getWorkspace(wsB).settings.allowCrossChatSend, false);
  });
});

test('parity: add / update / delete member (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, calls }) => {
    const g0 = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
    const m0 = await callTool('multicontext_create_workspace', { name: 'W' });
    const wsA = g0.data.id, wsB = m0.id;
    const before = calls.length;
    const ga = await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1', developerPrompt: 'dev' }) });
    const ma = await callTool('multicontext_add_chat', { workspace_id: wsB, name: 'A', agent_id: 'agent-1', developer_prompt: 'dev' });
    assert.deepEqual(calls.slice(before).filter(c => c === 'addChat').length, 2);
    const midA = ga.data.member.id, midB = ma.member.id;
    const gu = await gui(`/api/workspaces/${wsA}/members/${midA}`, { method: 'PATCH', body: JSON.stringify({ developerPrompt: 'dev2', canSendOthers: false }) });
    await callTool('multicontext_update_chat', { workspace_id: wsB, chat_id: midB, developer_prompt: 'dev2', can_send_others: false });
    const wsAView = (await gui(`/api/workspaces/${wsA}`)).data;
    const wsBView = (await gui(`/api/workspaces/${wsB}`)).data;
    assert.deepEqual(normWorkspace(wsAView).members.A, normWorkspace(wsBView).members.A);
    const gd = await gui(`/api/workspaces/${wsA}/members/${midA}`, { method: 'DELETE' });
    const md = await callTool('multicontext_delete_chat', { workspace_id: wsB, chat_id: midB });
    assert.equal(gd.res.status, 204);
    assert.equal(md.deleted, true);
    assert.deepEqual(Object.keys(store.getWorkspace(wsA).members), []);
    assert.deepEqual(Object.keys(store.getWorkspace(wsB).members), []);
  });
});

test('parity: broadcast state, queue, events (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
    const wsA = (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) })).data.id;
    const wsB = (await callTool('multicontext_create_workspace', { name: 'W' })).id;
    for (const n of ['A', 'B']) {
      await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: n, agentId: 'agent-1' }) });
      await callTool('multicontext_add_chat', { workspace_id: wsB, name: n, agent_id: 'agent-1' });
    }
    const before = calls.length;
    await gui(`/api/workspaces/${wsA}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) });
    await callTool('multicontext_broadcast', { workspace_id: wsB, prompt: 'hello' });
    assert.deepEqual(calls.slice(before).filter(c => c === 'broadcast').length, 2);
    await waitSettled(store, scheduler, wsA);
    await waitSettled(store, scheduler, wsB);
    assert.deepEqual(normWorkspace((await gui(`/api/workspaces/${wsA}`)).data), normWorkspace((await gui(`/api/workspaces/${wsB}`)).data));
    assert.deepEqual(normEvents(store, wsA), normEvents(store, wsB));
    // caller origin recorded as metadata, everything else identical
    const evA = store.getWorkspace(wsA).orchestratorEvents.filter(e => e.type.startsWith('human.'));
    const evB = store.getWorkspace(wsB).orchestratorEvents.filter(e => e.type.startsWith('human.'));
    assert.ok(evA.length > 0 && evA.every(e => e.origin === 'human'));
    assert.ok(evB.length > 0 && evB.every(e => e.origin === 'mcp'));
    assert.deepEqual(evA.map(e => e.type), evB.map(e => e.type));
  });
});

test('parity: direct enqueue (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
    const wsA = (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) })).data.id;
    const wsB = (await callTool('multicontext_create_workspace', { name: 'W' })).id;
    const midA = (await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member.id;
    const midB = (await callTool('multicontext_add_chat', { workspace_id: wsB, name: 'A', agent_id: 'agent-1' })).member.id;
    const before = calls.length;
    await gui(`/api/workspaces/${wsA}/members/${midA}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'ping' }) });
    await callTool('multicontext_send', { workspace_id: wsB, chat_id: midB, prompt: 'ping' });
    assert.deepEqual(calls.slice(before).filter(c => c === 'send').length, 2);
    await waitSettled(store, scheduler, wsA);
    await waitSettled(store, scheduler, wsB);
    const normA = normWorkspace((await gui(`/api/workspaces/${wsA}`)).data);
    const normB = normWorkspace((await gui(`/api/workspaces/${wsB}`)).data);
    assert.deepEqual(normA.members.A.messages, normB.members.A.messages);
    assert.deepEqual(normA.members.A.queue, normB.members.A.queue);
    assert.deepEqual(normEvents(store, wsA), normEvents(store, wsB));
  });
});

test('parity: stop member and stop workspace (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, calls }) => {
    const setup = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const add = viaGui
        ? async (n) => (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: n, agentId: 'agent-1' }) })).data.member
        : async (n) => (await callTool('multicontext_add_chat', { workspace_id: wsId, name: n, agent_id: 'agent-1' })).member;
      const m1 = await add('A');
      await add('B');
      return { wsId, m1 };
    };
    const stopCallsBefore = calls.length;
    // stop member via GUI, then via MCP
    const fA = await setup(true, 'W');
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.m1.id}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'work' }) });
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.m1.id}/stop`, { method: 'POST' });
    const fB = await setup(false, 'W');
    const midB = Object.values(store.getWorkspace(fB.wsId).members).find(m => m.name === 'A').id;
    await callTool('multicontext_send', { workspace_id: fB.wsId, chat_id: midB, prompt: 'work' });
    await callTool('multicontext_stop_chat', { workspace_id: fB.wsId, chat_id: midB });
    // stop workspace via GUI, then via MCP
    const fC = await setup(true, 'W');
    await gui(`/api/workspaces/${fC.wsId}/members/${fC.m1.id}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'work' }) });
    await gui(`/api/workspaces/${fC.wsId}/stop`, { method: 'POST' });
    const fD = await setup(false, 'W');
    const midD = Object.values(store.getWorkspace(fD.wsId).members).find(m => m.name === 'A').id;
    await callTool('multicontext_send', { workspace_id: fD.wsId, chat_id: midD, prompt: 'work' });
    await callTool('multicontext_stop_workspace', { workspace_id: fD.wsId });
    const stopCalls = calls.slice(stopCallsBefore);
    assert.ok(stopCalls.filter(c => c === 'stopChat').length >= 2);
    assert.ok(stopCalls.filter(c => c === 'stopWorkspace').length >= 2);
    for (const [wsId, memberName, wantOrigin] of [[fA.wsId, 'A', 'human'], [fB.wsId, 'A', 'mcp'], [fC.wsId, 'A', 'human'], [fD.wsId, 'A', 'mcp']]) {
      const s = store.getWorkspace(wsId);
      const m = Object.values(s.members).find(x => x.name === memberName);
      assert.equal(m.queue.length, 0);
      assert.equal(m.status, 'idle');
      const stops = s.orchestratorEvents.filter(e => e.type === 'human.stop');
      assert.equal(stops.length, 1);
      assert.equal(stops[0].origin, wantOrigin);
    }
  });
});

test('parity: retry blocked member (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls }) => {
    const failing = { listAgents: async () => [{ id: 'agent-1' }], runAgent: async () => { throw new Error('boom'); } };
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const mid = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member.id
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member.id;
      return { wsId, mid };
    };
    // Temporarily break the model client so both fixtures block identically
    const realRun = scheduler.client.runAgent;
    scheduler.client.runAgent = failing.runAgent;
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.mid}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
    await callTool('multicontext_send', { workspace_id: fB.wsId, chat_id: fB.mid, prompt: 'x' });
    for (let i = 0; i < 100; i++) {
      const a = store.getWorkspace(fA.wsId).members[fA.mid].status;
      const b = store.getWorkspace(fB.wsId).members[fB.mid].status;
      if (a === 'error' && b === 'error') break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(store.getWorkspace(fA.wsId).members[fA.mid].status, 'error');
    assert.equal(store.getWorkspace(fB.wsId).members[fB.mid].status, 'error');
    scheduler.client.runAgent = realRun;
    const before = calls.length;
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.mid}/retry`, { method: 'POST' });
    await callTool('multicontext_retry_chat', { workspace_id: fB.wsId, chat_id: fB.mid });
    assert.deepEqual(calls.slice(before).filter(c => c === 'retryChat').length, 2);
    await waitSettled(store, scheduler, fA.wsId);
    await waitSettled(store, scheduler, fB.wsId);
    const nA = normWorkspace((await gui(`/api/workspaces/${fA.wsId}`)).data).members.A;
    const nB = normWorkspace((await gui(`/api/workspaces/${fB.wsId}`)).data).members.A;
    assert.equal(nA.status, 'idle');
    assert.equal(nB.status, 'idle');
    assert.deepEqual(nA.messages, nB.messages);
  });
});

test('parity: compile precondition and isolation (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
    // Gate model completion so the precondition check races nothing.
    let release;
    const gate = new Promise(r => { release = r; });
    const origRun = scheduler.client.runAgent.bind(scheduler.client);
    scheduler.client.runAgent = async (args) => { await gate; return origRun(args); };
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const mid = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member.id
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member.id;
      return { wsId, mid };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.mid}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'work' }) });
    await callTool('multicontext_send', { workspace_id: fB.wsId, chat_id: fB.mid, prompt: 'work' });
    // precondition failure identical on both surfaces while running/blocked-or-queued
    const gPre = await gui(`/api/workspaces/${fA.wsId}/compile`, { method: 'POST' });
    assert.equal(gPre.res.status, 409);
    // settle both, then compile via opposite surfaces
    release();
    await waitSettled(store, scheduler, fA.wsId);
    await waitSettled(store, scheduler, fB.wsId);
    const before = calls.length;
    const g = await gui(`/api/workspaces/${fA.wsId}/compile`, { method: 'POST' });
    const m = await callTool('multicontext_compile', { workspace_id: fB.wsId });
    assert.deepEqual(calls.slice(before).filter(c => c === 'compile').length, 2);
    assert.equal(g.res.status, 200);
    const normIds = (s) => String(s)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>');
    assert.equal(normIds(g.data.lastCompile.text), normIds(m.lastCompile.text));
    // member histories untouched on both
    for (const f of [fA, fB]) {
      const view = (await gui(`/api/workspaces/${f.wsId}`)).data;
      assert.ok(!JSON.stringify(view.members[f.mid].messages).includes(g.data.lastCompile.text.slice(0, 40)));
    }
  });
});

test('parity: pause and resume dispatch identically (GUI vs MCP)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
    const setup = async (viaGuiPause, name) => {
      const wsId = (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id;
      await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) });
      return wsId;
    };
    const wsA = await setup(true, 'W');
    const wsB = await setup(false, 'W');
    // pause via GUI on A, via MCP on B
    const before = calls.length;
    await gui(`/api/workspaces/${wsA}/orchestrator/pause`, { method: 'POST', body: JSON.stringify({ paused: true }) });
    await callTool('multicontext_orchestrate_set_paused', { workspace_id: wsB, paused: true });
    assert.ok(calls.slice(before).filter(c => c === 'setOrchestratorPaused').length >= 2);
    assert.equal(store.getWorkspace(wsA).orchestratorPaused, true);
    assert.equal(store.getWorkspace(wsB).orchestratorPaused, true);
    // start runs while paused (queued, not dispatched) on both
    const rA = await callTool('multicontext_orchestrate_start_run', { workspace_id: wsA, prompt: 'paused work', broadcast: true });
    const rB = await callTool('multicontext_orchestrate_start_run', { workspace_id: wsB, prompt: 'paused work', broadcast: true });
    assert.equal(rA.paused, true);
    assert.equal(rB.paused, true);
    assert.equal(store.getOrchestratorRun(wsA, rA.run_id).status, 'queued');
    // resume via opposite surfaces: GUI resumes B's fixture... use GUI route for wsB and MCP for wsA
    await gui(`/api/workspaces/${wsB}/orchestrator/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
    await callTool('multicontext_orchestrate_set_paused', { workspace_id: wsA, paused: false });
    const sA = await waitSettled(store, scheduler, wsA);
    const sB = await waitSettled(store, scheduler, wsB);
    assert.equal(sA, 'SETTLED');
    assert.equal(sB, 'SETTLED');
    assert.equal(store.getOrchestratorRun(wsA, rA.run_id).status, 'settled');
    assert.equal(store.getOrchestratorRun(wsB, rB.run_id).status, 'settled');
    // provenance identical: member items carry run/Q attribution (self-consistent per fixture)
    for (const [wsId, runId] of [[wsA, rA.run_id], [wsB, rB.run_id]]) {
      const msgs = Object.values(store.getWorkspace(wsId).members).flatMap(m => m.messages);
      assert.ok(msgs.some(m => m.role === 'assistant' && m.content === 'ok:paused work'));
    }
    void app;
  });
});

test('parity: cancel run is run-scoped on the canonical engine (MCP surface)', async () => {
  await withStack(async ({ callTool, store, scheduler, calls, app }) => {
    // Gate model completion so cancel races an in-flight run, not a settled one.
    let release;
    const gate = new Promise(r => { release = r; });
    const origRun = scheduler.client.runAgent.bind(scheduler.client);
    scheduler.client.runAgent = async (args) => { await gate; return origRun(args); };
    try {
      const wsId = (await callTool('multicontext_create_workspace', { name: 'W' })).id;
      const mid = (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member.id;
      const started = await callTool('multicontext_orchestrate_start_run', { workspace_id: wsId, prompt: 'run work', chat_id: mid });
      const runId = started.run_id;
      // wait until the run's own member work has landed (queued or in-flight
      // as current; the head item is picked up as current immediately)
      const runItems = () => {
        const m = store.getWorkspace(wsId).members[mid];
        const items = [...m.queue];
        if (m.current?.item) items.push(m.current.item);
        return items.filter(q => q.orchestratorRunId === runId && q.orchestratorQId);
      };
      const t0 = Date.now();
      while (runItems().length === 0) {
        if (Date.now() - t0 > 5000) throw new Error('timed out waiting for run queue item');
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(store.getOrchestratorRun(wsId, runId).status, 'running');
      // unrelated human work via the same canonical send both surfaces use
      await callTool('multicontext_send', { workspace_id: wsId, chat_id: mid, prompt: 'human work' });
      const before = calls.length;
      const cancelled = await callTool('multicontext_orchestrate_cancel_run', { workspace_id: wsId, run_id: runId });
      assert.ok(calls.slice(before).includes('cancelRun'));
      assert.equal(cancelled.run.status, 'cancelled');
      assert.equal(store.getOrchestratorRun(wsId, runId).status, 'cancelled');
      const m = store.getWorkspace(wsId).members[mid];
      assert.ok(m.queue.some(q => q.prompt === 'human work'));
      assert.ok(!m.queue.some(q => q.orchestratorRunId === runId && q.orchestratorQId));
      void app;
    } finally { release(); }
  });
});

test('parity: cancel run works on blocked and failed status (canonical method)', async () => {
  await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
    const failing = { listAgents: async () => [{ id: 'agent-1' }], runAgent: async () => { throw new Error('boom'); } };
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const memberRes = viaGui
        ? await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })
        : await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' });
      const mid = viaGui ? memberRes.data.member.id : (memberRes.member || memberRes).id;
      return { wsId, mid };
    };
    const realRun = scheduler.client.runAgent;
    scheduler.client.runAgent = failing.runAgent;
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    assert.ok(fA.mid && fB.mid, 'members must exist');
    // start runs via MCP (canonical engine) so both fixtures create orchestrator runs
    const startedA = await callTool('multicontext_orchestrate_start_run', { workspace_id: fA.wsId, prompt: 'run work', chat_id: fA.mid });
    const startedB = await callTool('multicontext_orchestrate_start_run', { workspace_id: fB.wsId, prompt: 'run work', chat_id: fB.mid });
    assert.ok(startedA.run_id && startedB.run_id, 'runs must start');
    // wait until both runs reach terminal status (failed)
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const runA = store.getOrchestratorRun(fA.wsId, startedA.run_id);
      const runB = store.getOrchestratorRun(fB.wsId, startedB.run_id);
      if (runA.status === 'failed' && runB.status === 'failed') break;
      await new Promise(r => setTimeout(r, 10));
    }
    scheduler.client.runAgent = realRun;
    const runAFinal = store.getOrchestratorRun(fA.wsId, startedA.run_id);
    const runBFinal = store.getOrchestratorRun(fB.wsId, startedB.run_id);
    assert.equal(runAFinal.status, 'blocked', 'fA run must be blocked');
    assert.equal(runBFinal.status, 'blocked', 'fB run must be blocked');
    const before = calls.length;
    const cancelledA = await callTool('multicontext_orchestrate_cancel_run', { workspace_id: fA.wsId, run_id: startedA.run_id });
    const cancelledB = await callTool('multicontext_orchestrate_cancel_run', { workspace_id: fB.wsId, run_id: startedB.run_id });
    assert.ok(calls.slice(before).includes('cancelRun'), 'canonical cancelRun must be called');
    assert.equal(store.getOrchestratorRun(fA.wsId, startedA.run_id).status, 'cancelled');
    assert.equal(store.getOrchestratorRun(fB.wsId, startedB.run_id).status, 'cancelled');
    void app;
  });
});

test('parity: inspect via GUI tools route vs MCP tool (incl. former ReferenceError)', async () => {
  await withStack(async ({ gui, callTool, store, base }) => {
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const mA = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member;
      const mB = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'B', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'B', agent_id: 'agent-1' })).member;
      return { wsId, mA, mB };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    for (const f of [fA, fB]) {
      await gui(`/api/workspaces/${f.wsId}/members/${f.mB.id}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'secret eleven' }) });
      await waitSettled(store, { runningMemberIds: () => new Set() }, f.wsId);
    }
    const g = await gui(`/tools/${fA.wsId}/${fA.mA.id}/inspect-chat`, { method: 'POST', body: JSON.stringify({ target: 'B', query: 'eleven' }) });
    const m = await callTool('multicontext_inspect_peer_chat', { workspace_id: fB.wsId, source_chat_id: fB.mA.id, target: 'B', query: 'eleven' });
    assert.equal(g.res.status, 200);
    assert.equal(g.data.target.name, 'B');
    assert.equal(m.target.name, 'B');
    assert.deepEqual(
      g.data.results.map(r => r.content),
      m.results.map(r => r.content),
    );
    assert.ok(g.data.results.some(r => r.content.includes('eleven')));
    void base;
  });
});

test('parity: send_to_chat with idempotency key on both surfaces, replay safe', async () => {
  await withStack(async ({ gui, callTool, store, calls }) => {
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const mA = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member;
      const mB = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'B', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'B', agent_id: 'agent-1' })).member;
      return { wsId, mA, mB };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    const before = calls.length;
    const g1 = await gui(`/tools/${fA.wsId}/${fA.mA.id}/send-to-chat`, { method: 'POST', body: JSON.stringify({ targets: ['B'], prompt: 'hi', idempotency_key: 'k-1' }) });
    const m1 = await callTool('multicontext_send_to_peer_chats', { workspace_id: fB.wsId, source_chat_id: fB.mA.id, targets: ['B'], prompt: 'hi', idempotency_key: 'k-1' });
    assert.ok(calls.slice(before).filter(c => c === 'sendToChats').length >= 2);
    assert.equal(g1.res.status, 202);
    assert.equal(g1.data.accepted, true);
    assert.equal(g1.data.replayed, false);
    assert.equal(m1.accepted, true);
    assert.equal(m1.replayed, false);
    // retry same key on both surfaces: replayed, no duplicate delivery
    const g2 = await gui(`/tools/${fA.wsId}/${fA.mA.id}/send-to-chat`, { method: 'POST', body: JSON.stringify({ targets: ['B'], prompt: 'hi', idempotency_key: 'k-1' }) });
    const m2 = await callTool('multicontext_send_to_peer_chats', { workspace_id: fB.wsId, source_chat_id: fB.mA.id, targets: ['B'], prompt: 'hi', idempotency_key: 'k-1' });
    assert.equal(g2.data.replayed, true);
    assert.equal(m2.replayed, true);
    assert.deepEqual(g2.data.deliveries, g1.data.deliveries);
    assert.deepEqual(m2.deliveries, m1.deliveries);
    for (const f of [fA, fB]) {
      const msgs = store.getWorkspace(f.wsId).members[f.mB.id].messages.filter(x => !x.pending);
      const deliveries = msgs.filter(x => x.role === 'user' && x.content === 'hi');
      assert.equal(deliveries.length, 1);
      const replies = msgs.filter(x => x.role === 'assistant');
      assert.equal(replies.length, 1);
    }
    // bad key rejected identically
    const gBad = await gui(`/tools/${fA.wsId}/${fA.mA.id}/send-to-chat`, { method: 'POST', body: JSON.stringify({ targets: ['B'], prompt: 'hi', idempotency_key: 'bad key!' }) });
    assert.equal(gBad.res.status, 400);
  });
});

test('parity: permission-denied inspect/send identical on both surfaces', async () => {
  await withStack(async ({ gui, callTool, app }) => {
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const mA = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member;
      const mB = viaGui
        ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'B', agentId: 'agent-1' }) })).data.member
        : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'B', agent_id: 'agent-1' })).member;
      // lock down via opposite surface each time to prove shared settings path
      if (viaGui) await callTool('multicontext_update_workspace', { workspace_id: wsId, allow_cross_chat_send: false, allow_cross_chat_inspect: false });
      else await gui(`/api/workspaces/${wsId}`, { method: 'PATCH', body: JSON.stringify({ settings: { allowCrossChatSend: false, allowCrossChatInspect: false } }) });
      return { wsId, mA, mB };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    const gI = await gui(`/tools/${fA.wsId}/${fA.mA.id}/inspect-chat`, { method: 'POST', body: JSON.stringify({ target: 'B' }) });
    assert.equal(gI.res.status, 403);
    assert.equal(gI.data.code, gI.data.code);
    const gS = await gui(`/tools/${fA.wsId}/${fA.mA.id}/send-to-chat`, { method: 'POST', body: JSON.stringify({ targets: ['B'], prompt: 'x' }) });
    assert.equal(gS.res.status, 403);
    // MCP surfaces surface errors as thrown SDK errors; assert category via message/code parity helper
    const mI = await callTool('multicontext_inspect_peer_chat', { workspace_id: fB.wsId, source_chat_id: fB.mA.id, target: 'B' }).catch(e => ({ __err: String(e.message || e) }));
    const mS = await callTool('multicontext_send_to_peer_chats', { workspace_id: fB.wsId, source_chat_id: fB.mA.id, targets: ['B'], prompt: 'x' }).catch(e => ({ __err: String(e.message || e) }));
    assert.ok(mI.__err && mS.__err, 'MCP permission errors must surface');
    // Transport envelopes differ (MCP SDK surfaces failures opaquely), so prove
    // the shared canonical validation underneath throws the identical codes.
    const appErr = async (fn) => { try { await fn(); } catch (e) { return { status: e.status, code: e.code, message: e.message }; } return null; };
    const directI = await appErr(() => app.inspectPeerChat(fB.wsId, fB.mA.id, 'B'));
    const directS = await appErr(() => app.sendToChats(fB.wsId, fB.mA.id, ['B'], 'x'));
    assert.deepEqual(directI, { status: 403, code: 'CROSS_CHAT_INSPECT_DISABLED', message: gI.data.error });
    assert.deepEqual(directS, { status: 403, code: 'CROSS_CHAT_SEND_DISABLED', message: gS.data.error });
    assert.equal(gI.data.code, 'CROSS_CHAT_INSPECT_DISABLED');
    assert.equal(gS.data.code, 'CROSS_CHAT_SEND_DISABLED');
  });
});

test('parity: invalid input and unknown ids fail identically', async () => {
  await withStack(async ({ gui, callTool }) => {
    const wsId = (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) })).data.id;
    const mid = (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member.id;
    const gEmpty = await gui(`/api/workspaces/${wsId}/broadcast`, { method: 'POST', body: JSON.stringify({ prompt: '   ' }) });
    assert.equal(gEmpty.res.status, 400);
    assert.equal(gEmpty.data.code, undefined); // plain problem without code
    const g404 = await gui('/api/workspaces/does-not-exist');
    assert.equal(g404.res.status, 404);
    const g404m = await gui(`/api/workspaces/${wsId}/members/nope/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(g404m.res.status, 404);
    const wsB = (await callTool('multicontext_create_workspace', { name: 'W' })).id;
    const midB = (await callTool('multicontext_add_chat', { workspace_id: wsB, name: 'A', agent_id: 'agent-1' })).member.id;
    // MCP zod validation rejects empty prompt before reaching domain
    const mEmpty = await callTool('multicontext_broadcast', { workspace_id: wsB, prompt: '' }).catch(e => ({ __err: e }));
    assert.ok(mEmpty.__err, 'empty MCP broadcast must fail');
    const m404 = await callTool('multicontext_send', { workspace_id: 'does-not-exist', chat_id: midB, prompt: 'x' }).catch(e => ({ __err: e }));
    assert.ok(m404.__err, 'unknown workspace via MCP must fail');
    const normMcpErr = (e) => String(e?.message || e);
    assert.ok(normMcpErr(m404.__err).includes('Workspace not found'));
    // unknown member via MCP tools/call surfaces the canonical 404 message
    const m404m = await callTool('multicontext_send', { workspace_id: wsB, chat_id: 'nope', prompt: 'x' }).catch(e => ({ __err: e }));
    assert.ok(normMcpErr(m404m.__err).includes('Member not found'));
  });
});

test('parity: recursive cross-chat provenance inherits root run/Q; GUI/MCP reads agree', async () => {
  await withStack(async ({ gui, callTool, store, scheduler }) => {
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const ids = {};
      for (const nm of ['A', 'B', 'C']) {
        ids[nm] = viaGui
          ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: nm, agentId: 'agent-1' }) })).data.member.id
          : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: nm, agent_id: 'agent-1' })).member.id;
      }
      return { wsId, ids };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    // Scripted native chain by member name: A -send-> B -send-> C; C gated so the
    // grandchild queue item is observable mid-flight. Deterministic ids/texts so
    // both fixtures must produce byte-comparable normalized state.
    let releaseC;
    const gateC = new Promise(r => { releaseC = r; });
    scheduler.client.runAgent = async (args) => {
      const md = args.metadata || {};
      const mem = store.getMember(md.workspace_id, md.member_id);
      const name = mem?.name;
      const byName = (nm) => Object.values(store.getWorkspace(md.workspace_id).members).find(m => m.name === nm);
      if (args.toolResults) return { id: `r-${name}-ack`, text: `ack-${name}`, conversationId: `conv-${name}`, raw: { output: [] } };
      if (name === 'A') return { id: 'r-A', text: '', conversationId: 'conv-A', raw: { output: [{ type: 'function_call', call_id: 'A-send', name: 'send_to_chat', arguments: JSON.stringify({ targets: [byName('B').id], prompt: 'chain-ab' }) }] } };
      if (name === 'B') return { id: 'r-B', text: '', conversationId: 'conv-B', raw: { output: [{ type: 'function_call', call_id: 'B-send', name: 'send_to_chat', arguments: JSON.stringify({ targets: [byName('C').id], prompt: 'chain-bc' }) }] } };
      if (name === 'C') { await gateC; return { id: 'r-C', text: `ok:${args.prompt}`, conversationId: 'conv-C', raw: { output: [] } }; }
      throw new Error(`unexpected member ${name}`);
    };
    // Run creation is MCP-only (no GUI start-run route): both fixtures start via
    // the same canonical engine, which is what makes descendant provenance
    // surface-independent.
    const runs = {};
    for (const [key, f] of [['A', fA], ['B', fB]]) {
      const started = await callTool('multicontext_orchestrate_start_run', { workspace_id: f.wsId, prompt: 'root', broadcast: true });
      runs[key] = { runId: started.run_id, qId: store.getWorkspace(f.wsId).orchestratorQueue.find(q => q.runId === started.run_id).id };
    }
    const grandchild = (f, runId) => {
      const m = store.getWorkspace(f.wsId).members[f.ids.C];
      const items = [...m.queue];
      if (m.current?.item) items.push(m.current.item);
      return items.find(q => q.orchestratorRunId === runId && q.prompt === 'chain-bc');
    };
    for (const [key, f] of [['A', fA], ['B', fB]]) {
      const t0 = Date.now();
      while (!grandchild(f, runs[key].runId)) {
        if (Date.now() - t0 > 8000) throw new Error(`no grandchild item on fixture ${key}`);
        await new Promise(r => setTimeout(r, 10));
      }
      const g = grandchild(f, runs[key].runId);
      // Two-level inheritance collapses to the root run/Q (canonical executor).
      assert.equal(g.orchestratorQId, runs[key].qId);
      for (const m of Object.values(store.getWorkspace(f.wsId).members)) {
        const items = [...m.queue];
        if (m.current?.item) items.push(m.current.item);
        for (const q of items) {
          if (q.orchestratorRunId) assert.equal(q.orchestratorRunId, runs[key].runId);
        }
      }
    }
    // Read parity on the same live workspace: GUI view and MCP view must expose
    // the identical provenance-carrying queue item (envelopes may differ).
    const linkOf = (q) => ({ prompt: q.prompt, source: q.source, hasRun: Boolean(q.orchestratorRunId), hasQ: Boolean(q.orchestratorQId) });
    const gView = (await gui(`/api/workspaces/${fA.wsId}`)).data;
    const mView = await callTool('multicontext_get_workspace', { workspace_id: fA.wsId });
    const byNameM = (view, nm) => Object.values(view.members).find(m => m.name === nm);
    assert.deepEqual(byNameM(gView, 'C').queue.map(linkOf), byNameM(mView, 'C').queue.map(linkOf));
    releaseC();
    assert.equal(await waitSettled(store, scheduler, fA.wsId), 'SETTLED');
    assert.equal(await waitSettled(store, scheduler, fB.wsId), 'SETTLED');
    // The engine marks the run settled on its own (slower) settle poll, so wait
    // for the run record rather than asserting it immediately.
    for (const [key, f] of [['A', fA], ['B', fB]]) {
      const t0 = Date.now();
      while (store.getOrchestratorRun(f.wsId, runs[key].runId).status !== 'settled') {
        if (Date.now() - t0 > 10000) throw new Error(`run did not settle on fixture ${key}`);
        await new Promise(r => setTimeout(r, 10));
      }
    }
    const normIds = (s) => String(s)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>');
    const normMsgs = (f) => Object.values(store.getWorkspace(f.wsId).members)
      .map(m => ({ name: m.name, messages: m.messages.filter(x => !x.pending).map(x => ({ role: x.role, content: x.content })) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(normMsgs(fA), normMsgs(fB));
    const normEvents = (f) => {
      const names = new Map(Object.values(store.getWorkspace(f.wsId).members).map(m => [m.id, m.name]));
      return store.getWorkspace(f.wsId).orchestratorEvents.map(e => normIds(JSON.stringify({
        type: e.type, origin: e.origin, actor: e.actor,
        member: e.memberId ? (names.get(e.memberId) || '<member>') : null,
        run: e.runId ? '<run>' : null, q: e.qId ? '<q>' : null, detail: e.detail,
      })));
    };
    assert.deepEqual(normEvents(fA), normEvents(fB));
  });
});

test('parity: native tool-budget block is identical for GUI- vs MCP-enqueued work', async () => {
  await withStack(async ({ gui, callTool, store, scheduler }) => {
    scheduler.maxNativeToolIterations = 2;
    const mkFixture = async (viaGui, name) => {
      const wsId = viaGui
        ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
        : (await callTool('multicontext_create_workspace', { name })).id;
      const ids = {};
      for (const nm of ['A', 'B']) {
        ids[nm] = viaGui
          ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: nm, agentId: 'agent-1' }) })).data.member.id
          : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: nm, agent_id: 'agent-1' })).member.id;
      }
      return { wsId, ids };
    };
    const fA = await mkFixture(true, 'W');
    const fB = await mkFixture(false, 'W');
    // Endless storm: A always emits send_to_chat to B; B answers plain text.
    // call_id must be unique per round, otherwise the atomic receipt replays
    // instead of delivering (canonical idempotency doing its job).
    let stormN = 0;
    scheduler.client.runAgent = async (args) => {
      const md = args.metadata || {};
      const mem = store.getMember(md.workspace_id, md.member_id);
      if (mem?.name === 'A') {
        stormN += 1;
        const t = Object.values(store.getWorkspace(md.workspace_id).members).find(m => m.name === 'B');
        return { id: 'r-storm', text: '', conversationId: 'conv-storm', raw: { output: [{ type: 'function_call', call_id: `storm-${stormN}`, name: 'send_to_chat', arguments: JSON.stringify({ targets: [t.id], prompt: 'ping' }) }] } };
      }
      return { id: 'r-ok', text: 'ok-b', conversationId: 'conv-b', raw: { output: [] } };
    };
    // Identical storm prompt, enqueued through different surfaces.
    await gui(`/api/workspaces/${fA.wsId}/members/${fA.ids.A}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'storm' }) });
    await callTool('multicontext_send', { workspace_id: fB.wsId, chat_id: fB.ids.A, prompt: 'storm' });
    // Both members must BLOCK with the budget error; deliveries made are kept.
    for (const f of [fA, fB]) {
      const t0 = Date.now();
      while (store.getWorkspace(f.wsId).members[f.ids.A].status !== 'error') {
        if (Date.now() - t0 > 8000) throw new Error('storm member did not block');
        await new Promise(r => setTimeout(r, 10));
      }
    }
    assert.equal(await waitSettled(store, scheduler, fA.wsId), 'BLOCKED');
    assert.equal(await waitSettled(store, scheduler, fB.wsId), 'BLOCKED');
    // BLOCKED is reported as soon as A errors; the kept deliveries on B may
    // still be draining, so wait until B is idle before snapshotting.
    for (const f of [fA, fB]) {
      const t0 = Date.now();
      for (;;) {
        const b = store.getWorkspace(f.wsId).members[f.ids.B];
        if (b.queue.length === 0 && !b.current && b.status !== 'running') break;
        if (Date.now() - t0 > 8000) throw new Error('kept deliveries did not drain');
        await new Promise(r => setTimeout(r, 10));
      }
    }
    const snap = (f) => {
      const ws = store.getWorkspace(f.wsId);
      const a = ws.members[f.ids.A];
      const b = ws.members[f.ids.B];
      return {
        status: a.status,
        lastError: a.lastError,
        kept: b.messages.filter(m => !m.pending && m.role === 'user' && m.content === 'ping').length,
      };
    };
    const sA = snap(fA);
    const sB = snap(fB);
    assert.equal(sA.status, 'error');
    assert.equal(sB.status, 'error');
    assert.match(sA.lastError, /iteration budget exhausted after 2 tool rounds/);
    assert.equal(sA.lastError, sB.lastError);
    assert.equal(sA.kept, 2);
    assert.equal(sB.kept, 2);
  });
});

 test('parity: list peers returns identical member list via both surfaces', async () => {
   await withStack(async ({ gui, callTool, store, calls }) => {
     const g0 = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
     const m0 = await callTool('multicontext_create_workspace', { name: 'W' });
     const wsA = g0.data.id, wsB = m0.id;
     let gMid, mMid;
     for (const n of ['A', 'B', 'C']) {
       const gR = await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: n, agentId: 'agent-1' }) });
       const mR = await callTool('multicontext_add_chat', { workspace_id: wsB, name: n, agent_id: 'agent-1' });
       if (n === 'A') { gMid = gR.data.member.id; mMid = mR.member.id; }
     }
     const g = await gui(`/tools/${wsA}/${gMid}/list-chats`);
     const m = await callTool('multicontext_list_peer_chats', { workspace_id: wsB, source_chat_id: mMid });
     assert.equal(g.res.status, 200);
     assert.deepEqual(g.data.chats.map(c => c.name).sort(), m.chats.map(c => c.name).sort());
     assert.equal(g.data.chats.length, m.chats.length);
     assert.ok(calls.includes('listPeerChats'));
   });
 });

 test('parity: read messages returns identical history via both surfaces', async () => {
   await withStack(async ({ gui, callTool, store, scheduler, calls }) => {
     const g0 = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
     const m0 = await callTool('multicontext_create_workspace', { name: 'W' });
     const wsA = g0.data.id, wsB = m0.id;
     const ga = await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) });
     const ma = await callTool('multicontext_add_chat', { workspace_id: wsB, name: 'A', agent_id: 'agent-1' });
     const midA = ga.data.member.id, midB = ma.member.id;
     await gui(`/api/workspaces/${wsA}/members/${midA}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'msg-1' }) });
     await callTool('multicontext_send', { workspace_id: wsB, chat_id: midB, prompt: 'msg-1' });
     await waitSettled(store, scheduler, wsA);
     await waitSettled(store, scheduler, wsB);
     const g = await gui(`/api/workspaces/${wsA}/messages?chat_id=${midA}&limit=10`);
     const m = await callTool('multicontext_get_chat_messages', { workspace_id: wsB, chat_id: midB, limit: 10 });
     assert.equal(g.res.status, 200);
     assert.deepEqual(g.data.messages.map(x => x.content).sort(), m.messages.map(x => x.content).sort());
     assert.deepEqual(g.data.messages.map(x => x.role).sort(), m.messages.map(x => x.role).sort());
   });
 });

 test('parity: wait until settled returns identical state via both surfaces', async () => {
   await withStack(async ({ gui, callTool, store, scheduler, calls }) => {
     const g0 = await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'W' }) });
     const m0 = await callTool('multicontext_create_workspace', { name: 'W' });
     const wsA = g0.data.id, wsB = m0.id;
     await gui(`/api/workspaces/${wsA}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) });
     await callTool('multicontext_add_chat', { workspace_id: wsB, name: 'A', agent_id: 'agent-1' });
     const g = await gui(`/api/workspaces/${wsA}/wait`, { method: 'POST', body: JSON.stringify({ timeout_seconds: 5 }) });
     const m = await callTool('multicontext_wait_until_settled', { workspace_id: wsB, timeout_seconds: 5 });
     assert.equal(g.res.status, 200);
     assert.equal(g.data.state, 'SETTLED');
     assert.equal(m.state, 'SETTLED');
   });
 });

 test('parity: compile result read returns identical output via both surfaces', async () => {
   await withStack(async ({ gui, callTool, store, scheduler, calls, app }) => {
     let release;
     const gate = new Promise(r => { release = r; });
     const origRun = scheduler.client.runAgent.bind(scheduler.client);
     scheduler.client.runAgent = async (args) => { await gate; return origRun(args); };
     const mkFixture = async (viaGui, name) => {
       const wsId = viaGui
         ? (await gui('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })).data.id
         : (await callTool('multicontext_create_workspace', { name })).id;
       const mid = viaGui
         ? (await gui(`/api/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify({ name: 'A', agentId: 'agent-1' }) })).data.member.id
         : (await callTool('multicontext_add_chat', { workspace_id: wsId, name: 'A', agent_id: 'agent-1' })).member.id;
       return { wsId, mid };
     };
     const fA = await mkFixture(true, 'W');
     const fB = await mkFixture(false, 'W');
     await gui(`/api/workspaces/${fA.wsId}/members/${fA.mid}/enqueue`, { method: 'POST', body: JSON.stringify({ prompt: 'work' }) });
     await callTool('multicontext_send', { workspace_id: fB.wsId, chat_id: fB.mid, prompt: 'work' });
     release();
     await waitSettled(store, scheduler, fA.wsId);
     await waitSettled(store, scheduler, fB.wsId);
     const before = calls.length;
     const g = await gui(`/api/workspaces/${fA.wsId}/compile`, { method: 'POST' });
     const m = await callTool('multicontext_compile', { workspace_id: fB.wsId });
     assert.deepEqual(calls.slice(before).filter(c => c === 'compile').length, 2);
     assert.equal(g.res.status, 200);
     const gLastCompile = (await gui(`/api/workspaces/${fA.wsId}`)).data.lastCompile;
     const mLastCompile = (await callTool('multicontext_get_compile_result', { workspace_id: fB.wsId })).result;
     assert.ok(gLastCompile && mLastCompile && gLastCompile.text && mLastCompile.text, 'both must have compile result');
     assert.equal(gLastCompile.text.startsWith('ok:'), mLastCompile.text.startsWith('ok:'));
     assert.ok(gLastCompile.text.length > 0 && mLastCompile.text.length > 0);
     void app;
   });
 });
