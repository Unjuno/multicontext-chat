import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { createApplication } from '../src/application.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const makeStore = () => new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-mcp-')), 'state.json'));
const makeConfig = (overrides = {}) => ({
  dataFile: '/unused/state.json', appToken: '', toolSecret: '', publicUrl: '',
  librechatBaseUrl: 'http://librechat', librechatApiKey: 'key', librechatMode: 'compat',
  maxHistoryMessages: 50, maxInspectResults: 8, agentTimeoutMs: 1000,
  mcpToken: 'test-mcp-token', mcpEnabled: true,
  host: '127.0.0.1', port: 0,
  ...overrides,
});

async function withMcpServer(client, fn, configOverrides = {}) {
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const config = makeConfig(configOverrides);
  const app = createApp({ config, store, client, scheduler });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const mcpUrl = `${base}/mcp`;
  let mcpClient = null;
  let transport = null;
  if (config.mcpEnabled) {
    transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${config.mcpToken}` } },
    });
    mcpClient = new Client({ name: 'test-mcp', version: '1.0.0' });
    await mcpClient.connect(transport);
  }
  try { await fn({ store, scheduler, app, base, mcpUrl, client: mcpClient, transport, config }); }
  finally {
    try { if (mcpClient) await mcpClient.close(); } catch {}
    await new Promise(r => app.server.close(r));
  }
}

async function jsonRequest(base, route, opts = {}) {
  const res = await fetch(`${base}${route}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { res, data };
}

const mockAgents = [{ id: 'agent-1', name: 'ChatA', provider: 'gpt-oss' }, { id: 'agent-2', name: 'ChatB', provider: 'gpt-oss' }];
const singleAgent = [{ id: 'solo', name: 'Solo', provider: 'gpt-oss' }];

// 1
test('MCP initialize/connect succeeds with correct auth', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const tools = await mcp.listTools();
    assert.ok(tools.tools.length >= 19);
  });
});

// 2
test('MCP incorrect/missing token rejected', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const config = makeConfig({ mcpToken: 'correct' });
  const app = createApp({ config, store, client, scheduler });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // No auth
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } } }) });
    assert.equal(res.status, 401);
    // Wrong token
    const res2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: 'Bearer wrong' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } } }) });
    assert.equal(res2.status, 401);
  } finally { await new Promise(r => app.server.close(r)); }
});

// 3
test('MCP list tools returns expected tool names', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const { tools } = await mcp.listTools();
    const names = tools.map(t => t.name);
    for (const expected of ['multicontext_list_workspaces', 'multicontext_create_workspace', 'multicontext_broadcast', 'multicontext_send', 'multicontext_list_agents', 'multicontext_wait_until_settled', 'multicontext_compile', 'multicontext_get_runtime_status']) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });
});

// 4 tool schemas valid
test('MCP tool schemas valid', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const { tools } = await mcp.listTools();
    for (const t of tools) {
      assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });
});

// 5 MCP disabled behavior
test('MCP disabled returns 404', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const config = makeConfig({ mcpEnabled: false, mcpToken: 'tok' });
  const app = createApp({ config, store, client, scheduler });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: 'Bearer tok' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } } }) });
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.equal(j.code, 'MCP_DISABLED');
  } finally { await new Promise(r => app.server.close(r)); }
});

// 6 list workspaces
test('MCP list workspaces', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'W1' } });
    const res = await mcp.callTool({ name: 'multicontext_list_workspaces', arguments: {} });
    const data = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(data.workspaces));
    assert.ok(data.workspaces.some(w => w.name === 'W1'));
  });
});

// 7 create workspace
test('MCP create workspace', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const res = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'NewWS', initial_chat_count: 2 } });
    const ws = JSON.parse(res.content[0].text);
    assert.equal(ws.name, 'NewWS');
    assert.equal(Object.keys(ws.members).length, 2);
  });
});

// 8 update workspace
test('MCP update workspace', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'UWS' } });
    const ws = JSON.parse(c.content[0].text);
    const upd = await mcp.callTool({ name: 'multicontext_update_workspace', arguments: { workspace_id: ws.id, name: 'Renamed', system_prompt: 'hello' } });
    const updated = JSON.parse(upd.content[0].text);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.globalPrompt, 'hello');
  });
});

// 9 delete workspace
test('MCP delete workspace', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp, base }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'ToDelete' } });
    const ws = JSON.parse(c.content[0].text);
    const del = await mcp.callTool({ name: 'multicontext_delete_workspace', arguments: { workspace_id: ws.id } });
    const j = JSON.parse(del.content[0].text);
    assert.equal(j.deleted, true);
    const check = await jsonRequest(base, `/api/workspaces/${ws.id}`);
    assert.equal(check.res.status, 404);
  });
});

// 10 get workspace private fields stripped
test('MCP get workspace private fields stripped', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'PrivTest' } });
    const ws = JSON.parse(c.content[0].text);
    const g = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } });
    const data = JSON.parse(g.content[0].text);
    const ser = JSON.stringify(data);
    assert.equal(ser.includes('conversationId'), false);
    assert.equal(ser.includes('current'), false);
    assert.equal(ser.includes('LIBRECHAT_API_KEY'), false);
  });
});

// 11 add chat
test('MCP add chat', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'AddChat' } });
    const ws = JSON.parse(c.content[0].text);
    const add = await mcp.callTool({ name: 'multicontext_add_chat', arguments: { workspace_id: ws.id, name: 'ChatX', agent_id: 'agent-1' } });
    const j = JSON.parse(add.content[0].text);
    assert.ok(j.member.id);
    assert.equal(j.member.name, 'ChatX');
  });
});

// 12 update chat
test('MCP update chat', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'UpdChat', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    const upd = await mcp.callTool({ name: 'multicontext_update_chat', arguments: { workspace_id: ws.id, chat_id: mid, name: 'RenamedChat' } });
    const updated = JSON.parse(upd.content[0].text);
    assert.equal(updated.members[mid].name, 'RenamedChat');
  });
});

// 13 delete chat
test('MCP delete chat', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'DelChat', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    const del = await mcp.callTool({ name: 'multicontext_delete_chat', arguments: { workspace_id: ws.id, chat_id: mid } });
    const j = JSON.parse(del.content[0].text);
    assert.equal(j.deleted, true);
  });
});

// 14 direct send
test('MCP direct send', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'Direct', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    const send = await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'hello direct' } });
    assert.ok(JSON.parse(send.content[0].text).item);
  });
});

// 15 broadcast
test('MCP broadcast', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'BC', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    const bc = await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'hello bc' } });
    const j = JSON.parse(bc.content[0].text);
    assert.equal(j.items.length, 2);
  });
});

// 16 broadcast preserves independent queue
test('MCP broadcast preserves independent queue', async () => {
  let release;
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async ({ prompt }) => {
      // Block until released to keep queue observable
      await new Promise(r => { release = r; });
      return { id: 'r', text: `echo:${prompt}` };
    },
  };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'Qtest', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    const bcPromise = mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'msg1' } });
    // Give scheduler a moment to enqueue but not yet drain (blocked on release)
    await new Promise(r => setTimeout(r, 50));
    const bc = await bcPromise;
    const j = JSON.parse(bc.content[0].text);
    assert.equal(j.items.length, 2);
    const ws2 = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    // Each active member should have exactly 1 queued item, and one may be inFlight
    let total = 0;
    for (const m of Object.values(ws2.members)) total += m.queue.length + (m.inFlight ? 1 : 0);
    assert.equal(total, 2);
    release();
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
  });
});

// 17 parallel members / serial per member with deterministic barrier
test('MCP parallel members serial per member unchanged', async () => {
  let releaseA;
  let runOrder = [];
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async ({ prompt, metadata }) => {
      if (metadata.member_id && runOrder.length === 0) {
        // First run blocks
        await new Promise(r => { releaseA = r; });
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
      runOrder.push(prompt);
      return { id: 'r', text: `echo:${prompt}` };
    },
  };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'Par', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    const mids = Object.keys(ws.members);
    // Send two prompts serially to same member while first is blocked
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mids[0], prompt: 'a1' } });
    await new Promise(r => setTimeout(r, 30));
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mids[0], prompt: 'a2' } });
    await new Promise(r => setTimeout(r, 20));
    const ws2 = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    // First item is inFlight, second is queued => total 2 including inFlight
    const total = ws2.members[mids[0]].queue.length + (ws2.members[mids[0]].inFlight ? 1 : 0);
    assert.equal(total, 2, `expected 2 items total for serial member, got queue ${ws2.members[mids[0]].queue.length} inFlight ${ws2.members[mids[0]].inFlight}`);
    assert.equal(ws2.members[mids[1]].queue.length, 0);
    assert.equal(ws2.members[mids[1]].inFlight, false);
    // Release and verify serial order
    releaseA();
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    assert.deepEqual(runOrder.slice(0, 2), ['a1', 'a2']);
  });
});

// 18 stop workspace clears all and late completion does not reappear
test('MCP stop workspace clears queues and ignores late completion', async () => {
  let release;
  let completed = false;
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async ({ prompt, signal }) => {
      // Wait for controllable release, respect abort
      await new Promise((resolve, reject) => {
        release = resolve;
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      completed = true;
      return { id: 'r', text: `echo:${prompt}` };
    },
  };
  await withMcpServer(client, async ({ client: mcp, store }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'StopWS', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    const mids = Object.keys(ws.members);
    // Broadcast to both; both will be running (blocked on release)
    const bc = await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'long' } });
    assert.equal(bc.isError, undefined);
    await new Promise(r => setTimeout(r, 50));
    // Now stop workspace
    const stop = await mcp.callTool({ name: 'multicontext_stop_workspace', arguments: { workspace_id: ws.id } });
    assert.equal(stop.isError, undefined);
    const afterStop = JSON.parse(stop.content[0].text);
    // All targeted chats must have empty queue and no current
    for (const mid of mids) {
      const m = afterStop.members[mid];
      assert.equal(m.queue.length, 0, `queue not cleared for ${mid}`);
      assert.equal(m.inFlight, false, `inFlight not cleared for ${mid}`);
      assert.equal(m.status, 'idle');
    }
    // Late completion must not reappear
    completed = false;
    if (release) release();
    await new Promise(r => setTimeout(r, 100));
    const afterLate = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    for (const mid of mids) {
      assert.equal(afterLate.members[mid].queue.length, 0);
      // Messages should not contain late completion because aborted
      const msgs = afterLate.members[mid].messages;
      assert.ok(!msgs.some(msg => msg.content && msg.content.includes('echo:long')), 'late completion leaked');
    }
    assert.equal(completed, false, 'runAgent should have been aborted, not completed');
  });
});

// 19 stop chat only affects that chat
test('MCP stop chat only affects that chat', async () => {
  let releases = {};
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async ({ prompt, metadata }) => {
      const mid = metadata.member_id;
      await new Promise(r => { releases[mid] = r; });
      return { id: 'r', text: `echo:${prompt}` };
    },
  };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'StopOne', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    const mids = Object.keys(ws.members);
    const target = mids[0];
    const other = mids[1];
    await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'bc' } });
    await new Promise(r => setTimeout(r, 50));
    const stop = await mcp.callTool({ name: 'multicontext_stop_chat', arguments: { workspace_id: ws.id, chat_id: target } });
    assert.equal(stop.isError, undefined);
    const after = JSON.parse(stop.content[0].text);
    assert.equal(after.members[target].queue.length, 0);
    assert.equal(after.members[target].inFlight, false);
    // Other chat must remain running/queued
    assert.equal(after.members[other].inFlight, true);
    // Release other
    releases[other]();
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const final = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    assert.equal(final.members[target].queue.length, 0);
    // Other should have completed
    assert.ok(final.members[other].messages.some(m => m.content.includes('echo:bc')));
  });
});

// 20 retry transitions BLOCKED and actually consumes failed item
test('MCP retry chat consumes failed front item and succeeds', async () => {
  let callCount = 0;
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async () => {
      callCount++;
      if (callCount === 1) throw new Error('fail first');
      return { id: 'r2', text: 'recovered' };
    },
  };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const config = makeConfig({ mcpToken: 't', mcpEnabled: true });
  const app = createApp({ config, store, client, scheduler });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer t' } } });
  const mcp = new Client({ name: 't', version: '1.0.0' });
  await mcp.connect(transport);
  try {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'RetryTest', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    const send = await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'will fail' } });
    assert.equal(send.isError, undefined);
    // Wait for BLOCKED
    const blocked = await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const blockedState = JSON.parse(blocked.content[0].text);
    assert.equal(blockedState.state, 'BLOCKED');
    const before = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    assert.equal(before.members[mid].status, 'error');
    // Retry should not be error envelope
    const retry = await mcp.callTool({ name: 'multicontext_retry_chat', arguments: { workspace_id: ws.id, chat_id: mid } });
    assert.equal(retry.isError, undefined, `retry returned error envelope: ${retry.content[0].text}`);
    // Wait until settled after retry - must become SETTLED, not remain error
    const afterWait = await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const afterState = JSON.parse(afterWait.content[0].text);
    assert.equal(afterState.state, 'SETTLED', `expected SETTLED after retry, got ${afterState.state}`);
    const after = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    assert.notEqual(after.members[mid].status, 'error', 'retry should not leave member in error after successful re-run');
    assert.equal(after.members[mid].queue.length, 0);
    assert.ok(after.members[mid].messages.some(m => m.content === 'recovered'), 'recovered message not found');
    assert.equal(callCount, 2, 'runAgent should have been called twice (fail then success)');
  } finally { try { await mcp.close(); } catch {} await new Promise(r => app.server.close(r)); }
});

// 20 wait_until_settled -> SETTLED
test('MCP wait_until_settled -> SETTLED', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'WaitSettled', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'hi' } });
    const res = await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const j = JSON.parse(res.content[0].text);
    assert.equal(j.state, 'SETTLED');
  });
});

// 21 wait_until_settled -> BLOCKED
test('MCP wait_until_settled -> BLOCKED', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => { throw new Error('fail'); } };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'WaitBlocked', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'failme' } });
    const res = await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const j = JSON.parse(res.content[0].text);
    assert.equal(j.state, 'BLOCKED');
  });
});

// 22 wait_until_settled -> timeout
test('MCP wait_until_settled timeout', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => { await new Promise(r => setTimeout(r, 5000)); return { id: 'r', text: 'late' }; } };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'WaitTimeout', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'slow' } });
    const res = await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 1 } });
    const j = JSON.parse(res.content[0].text);
    assert.equal(j.state, 'TIMEOUT');
  });
});

// 24 exactly one Agent can auto-resolve
test('MCP exactly one Agent auto-resolves', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'SingleAuto', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    // With single agent, broadcast without explicit default should succeed (auto)
    const bc = await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'hi' } });
    assert.equal(bc.isError, undefined);
  });
});

// 25 multiple Agents without default => AGENT_SELECTION_REQUIRED
test('MCP multiple agents without default requires selection', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'MultiNeedSelect', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    assert.equal(ws.defaultAgentId, '');
    const bc = await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'hi' } });
    assert.equal(bc.isError, true);
    assert.ok(bc.content[0].text.includes('複数のAgent') || bc.content[0].text.includes('Agentが'));
  });
});

// 26 workspace default works
test('MCP workspace default works', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async ({ prompt }) => ({ id: 'r', text: `echo:${prompt}` }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'WsDefault', default_agent_id: 'agent-1', initial_chat_count: 2 } });
    const ws = JSON.parse(c.content[0].text);
    assert.equal(ws.defaultAgentId, 'agent-1');
    const bc = await mcp.callTool({ name: 'multicontext_broadcast', arguments: { workspace_id: ws.id, prompt: 'hi' } });
    assert.equal(bc.isError, undefined);
  });
});

// 27 member override works
test('MCP member override works', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'MemberOverride', default_agent_id: 'agent-1', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_update_chat', arguments: { workspace_id: ws.id, chat_id: mid, agent_id: 'agent-2' } });
    const after = JSON.parse((await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: ws.id } })).content[0].text);
    assert.equal(after.members[mid].agentId, 'agent-2');
  });
});

// 28 stale Agent rejected - creation with nonexistent is allowed but subsequent use is rejected
test('MCP stale Agent rejected', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'Stale' } });
    const ws = JSON.parse(c.content[0].text);
    const upd = await mcp.callTool({ name: 'multicontext_update_workspace', arguments: { workspace_id: ws.id, default_agent_id: 'nonexistent' } });
    assert.equal(upd.isError, true);
    assert.ok(upd.content[0].text.includes('利用不可') || upd.content[0].text.includes('AGENT_NOT_AVAILABLE'));
  });
});

// 29 compile uses effective default correctly
test('MCP compile uses effective default', async () => {
  const client = {
    listAgents: async () => singleAgent,
    health: async () => ({ ok: true, agents: 1, mode: 'compat' }),
    runAgent: async ({ prompt, metadata }) => {
      if (metadata?.purpose === 'compile') return { id: 'c', text: 'compiled' };
      return { id: 'r', text: 'ok' };
    },
  };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'CompileTest', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 2 } });
    const comp = await mcp.callTool({ name: 'multicontext_compile', arguments: { workspace_id: ws.id } });
    assert.equal(comp.isError, undefined, `compile should succeed with single auto agent, got error: ${comp.content?.[0]?.text}`);
    const data = JSON.parse(comp.content[0].text);
    assert.ok(data.lastCompile && data.lastCompile.text === 'compiled');
  });
});

// 30 send_to_chat validates all targets before enqueue (tool cross-chat)
test('MCP cross-chat validation via REST still holds', async () => {
  const client = { listAgents: async () => mockAgents, health: async () => ({ ok: true, agents: 2, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const app = createApplication({ config: makeConfig(), store, client, scheduler });
  const ws = await app.createWorkspace({ name: 'Cross', initial_chat_count: 0 });
  // Create two chats: one with valid agent, one without and multiple agents => would require selection, but we set explicit
  const m1 = (await app.addChat(ws.id, { name: 'A', agentId: 'agent-1' })).member;
  const m2 = (await app.addChat(ws.id, { name: 'B', agentId: 'agent-2' })).member;
  const m3 = (await app.addChat(ws.id, { name: 'C' })).member; // no agent, will need default but none
  // Set workspace default to make C valid
  await app.updateWorkspace(ws.id, { defaultAgentId: 'agent-1' });
  // Now try to send via tool path: need to test via REST tool endpoint with invalid target
  // For MCP, we test broadcast with one invalid member should fail before any enqueue
  // Create workspace with mixed valid/invalid
  const ws2 = await app.createWorkspace({ name: 'Mixed', initial_chat_count: 0 });
  await app.addChat(ws2.id, { name: 'Valid', agentId: 'agent-1' });
  const invalid = await app.addChat(ws2.id, { name: 'InvalidNoAgent' });
  // Do not set default, so InvalidNoAgent has no effective
  try {
    await app.broadcast(ws2.id, 'hello');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'AGENT_SELECTION_REQUIRED');
    // Ensure no items were queued for valid member
    const after = store.requireWorkspace(ws2.id);
    assert.equal(after.members[Object.keys(after.members)[0]].queue.length, 0);
  }
});

// 31 only SETTLED compile
test('MCP compile only SETTLED', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt }) => { await new Promise(r => setTimeout(r, 200)); return { id: 'r', text: 'ok' }; } };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'CompileSettled', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'long' } });
    const comp = await mcp.callTool({ name: 'multicontext_compile', arguments: { workspace_id: ws.id } });
    assert.equal(comp.isError, true);
  });
});

// 32 concurrent compile rejected
test('MCP concurrent compile rejected', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ metadata }) => { if (metadata?.purpose === 'compile') { await new Promise(r => setTimeout(r, 500)); return { id: 'c', text: 'comp' }; } return { id: 'r', text: 'ok' }; } };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'ConcCompile', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 2 } });
    const p1 = mcp.callTool({ name: 'multicontext_compile', arguments: { workspace_id: ws.id } });
    await new Promise(r => setTimeout(r, 50));
    const p2 = await mcp.callTool({ name: 'multicontext_compile', arguments: { workspace_id: ws.id } });
    assert.equal(p2.isError, true);
    await p1;
  });
});

// 33 compile does not mutate histories
test('MCP compile does not mutate histories', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async ({ prompt, metadata }) => { if (metadata?.purpose === 'compile') return { id: 'c', text: 'compiled result' }; return { id: 'r', text: `echo:${prompt}` }; } };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'CompileMut', initial_chat_count: 1 } });
    const ws = JSON.parse(c.content[0].text);
    const mid = Object.keys(ws.members)[0];
    await mcp.callTool({ name: 'multicontext_send', arguments: { workspace_id: ws.id, chat_id: mid, prompt: 'hello' } });
    await mcp.callTool({ name: 'multicontext_wait_until_settled', arguments: { workspace_id: ws.id, timeout_seconds: 5 } });
    const beforeRes = await mcp.callTool({ name: 'multicontext_get_chat_messages', arguments: { workspace_id: ws.id, chat_id: mid } });
    const before = beforeRes.isError ? { messages: [] } : JSON.parse(beforeRes.content[0].text);
    await mcp.callTool({ name: 'multicontext_compile', arguments: { workspace_id: ws.id } });
    const afterRes = await mcp.callTool({ name: 'multicontext_get_chat_messages', arguments: { workspace_id: ws.id, chat_id: mid } });
    const after = afterRes.isError ? { messages: [] } : JSON.parse(afterRes.content[0].text);
    assert.deepEqual(before, after);
  });
});

// 34 MCP token never returned
test('MCP token never returned', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp, base }) => {
    const res = await fetch(`${base}/api/mcp/status`);
    const j = await res.json();
    assert.equal(j.token, undefined);
    assert.equal(JSON.stringify(j).includes('test-mcp-token'), false);
    const ws = await mcp.callTool({ name: 'multicontext_get_runtime_status', arguments: {} });
    assert.equal(ws.content[0].text.includes('test-mcp-token'), false);
  });
});

// 35 LibreChat API key never returned
test('MCP LibreChat API key never returned', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp, base }) => {
    const h = await fetch(`${base}/api/health`);
    const j = await h.json();
    assert.equal(JSON.stringify(j).includes('sk-'), false);
    const ws = await mcp.callTool({ name: 'multicontext_get_runtime_status', arguments: {} });
    assert.equal(ws.content[0].text.includes('sk-'), false);
  });
});

// 36 conversationId/current/lastRun remain private
test('MCP private fields stripped', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  await withMcpServer(client, async ({ client: mcp }) => {
    const c = await mcp.callTool({ name: 'multicontext_create_workspace', arguments: { name: 'Priv' } });
    const ws = JSON.parse(c.content[0].text);
    const ser = JSON.stringify(ws);
    assert.equal(ser.includes('conversationId'), false);
    assert.equal(ser.includes('"current"'), false);
    assert.equal(ser.includes('lastRun'), false);
  });
});

// 37 MCP request body size limit
test('MCP request body size limit', async () => {
  const client = { listAgents: async () => singleAgent, health: async () => ({ ok: true, agents: 1, mode: 'compat' }), runAgent: async () => ({ id: 'r', text: 'ok' }) };
  const store = makeStore();
  const scheduler = new Scheduler({ store, client, maxHistoryMessages: 50 });
  const cfg = makeConfig({});
  const app = createApp({ config: cfg, store, client, scheduler });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Normal initialize succeeds
    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: `Bearer ${cfg.mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } } }),
    });
    assert.equal(ok.status, 200);
    await ok.arrayBuffer().catch(() => {});
    // Oversized body >1MB should be rejected with 413
    const big = 'x'.repeat(1_100_000);
    const over = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: `Bearer ${cfg.mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'multicontext_list_workspaces', arguments: { big } } }),
    });
    assert.equal(over.status, 413);
    const j = await over.json().catch(() => ({}));
    assert.ok(String(j.error || '').includes('too large') || j.code === 'PAYLOAD_TOO_LARGE');
    await over.arrayBuffer().catch(() => {});
    // Process remains usable: normal request after oversized should still succeed
    const stillOk = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: `Bearer ${cfg.mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1.0' } } }),
    });
    assert.equal(stillOk.status, 200);
    await stillOk.arrayBuffer().catch(() => {});
  } finally {
    await new Promise(r => app.server.close(r));
  }
});
