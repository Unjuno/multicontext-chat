#!/usr/bin/env node
// Real source-server + HTTP MCP + local-model Phase 1 experiment.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { LocalModelClient } from '../src/local-model.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';

const prompt = process.argv[2] || 'For incompressible 3D Navier-Stokes on R3, audit this candidate: pointwise |grad u|^2 = 2|S|^2 + |curl u|^2, where S=(grad u+grad u transpose)/2. Treat it as untrusted. Do not discuss the Millennium problem generally.';
const directory = await fs.mkdtemp(path.resolve('data/experiments/obligation-mcp-'));
const dataFile = path.join(directory, 'state.json');
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const store = new StateStore(dataFile);
const modelClient = new LocalModelClient({ baseUrl: config.localModelUrl, directory: path.join(directory, 'conversations') });
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const invoke = modelClient[method].bind(modelClient);
  modelClient[method] = async ({ signal, ...input }) => {
    const entry = { method, input, startedAt: new Date().toISOString() };
    trace.push(entry); await save('model-trace.json', trace);
    const started = Date.now();
    try { entry.response = await invoke({ ...input, signal }); return entry.response; }
    catch (error) { entry.error = { name: error.name, message: error.message }; throw error; }
    finally { entry.elapsedMs = Date.now() - started; await save('model-trace.json', trace); }
  };
}
const scheduler = new Scheduler({ store, client: modelClient, maxConcurrentRequests: 4 });
const runtime = createApp({ config: { ...config, backend: 'local', dataFile, host: '127.0.0.1', port: 0,
  mcpEnabled: true, mcpToken: 'experiment-token', appToken: '', toolSecret: '' }, store, client: modelClient, scheduler });
await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${runtime.server.address().port}/mcp`;
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer experiment-token' } } });
const mcp = new Client({ name: 'obligation-real-experiment', version: '1' });
const started = Date.now();
try {
  await mcp.connect(transport);
  await save('setup.json', { prompt, url, preset: 'evidence-obligation-4', sourceServer: true, backend: 'local' });
  console.log(JSON.stringify({ directory }));
  const created = await mcp.callTool({ name: 'multicontext_orchestrate_create_session', arguments: {
    preset: 'evidence-obligation-4', name: 'Real MCP obligation experiment',
  } });
  assert.ok(!created.isError, JSON.stringify(created));
  const workspaceId = created.structuredContent.workspace.id;
  const startedRun = await mcp.callTool({ name: 'multicontext_orchestrate_start_run', arguments: {
    workspace_id: workspaceId, prompt, broadcast: true,
  } });
  assert.ok(!startedRun.isError, JSON.stringify(startedRun));
  const runId = startedRun.structuredContent.run_id;
  let run;
  for (let poll = 0; poll < 600; poll++) {
    const status = await mcp.callTool({ name: 'multicontext_orchestrate_get_run', arguments: {
      workspace_id: workspaceId, run_id: runId,
    } });
    assert.ok(!status.isError, JSON.stringify(status));
    run = status.structuredContent.run;
    if (['settled', 'blocked', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run?.status, 'settled', `Run did not settle: ${JSON.stringify(run)}`);
  const workspace = store.getWorkspace(workspaceId);
  const members = Object.values(workspace.members);
  assert.equal(members.length, 4);
  assert.ok(members.every(member => !member.canInspectOthers && !member.canSendOthers));
  assert.ok(members.every(member => member.status === 'idle' && !member.queue.length && !member.inFlight));
  const result = { workspaceId, runId, elapsedMs: Date.now() - started, run,
    modelRequests: trace.length, permissionsEnforced: true,
    members: members.map(member => ({ id: member.id, name: member.name, status: member.status,
      answer: member.messages.filter(message => message.role === 'assistant' && !message.pending).at(-1) })) };
  await save('result.json', result);
  console.log(JSON.stringify({ directory, workspaceId, elapsedMs: result.elapsedMs, modelRequests: result.modelRequests,
    memberTools: result.members.map(member => ({ name: member.name, tools: member.answer?.toolEvidence })) }));
} finally {
  await mcp.close().catch(() => {});
  await new Promise(resolve => runtime.server.close(resolve));
}
