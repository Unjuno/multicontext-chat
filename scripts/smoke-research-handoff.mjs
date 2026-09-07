#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { config } from '../src/config.js';
const serverModule = process.argv[3] ? pathToFileURL(path.resolve(process.argv[3])).href : new URL('../src/server.js', import.meta.url).href;
const { createApp } = await import(serverModule);

if (!process.argv[2]) throw new Error('Specify a recorded experiment state.json');
const source = path.resolve(process.argv[2]);
const original = fs.readFileSync(source);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-handoff-'));
const dataFile = path.join(directory, 'state.json');
fs.copyFileSync(source, dataFile);
const runtime = createApp({ config: { ...config, backend: 'local', dataFile, host: '127.0.0.1', mcpHost: '127.0.0.1', mcpEnabled: true, mcpToken: '', appToken: '', toolSecret: '' },
  client: { listAgents: async () => [], runAgent: async () => { throw new Error('Read-only extraction must not call the model'); } } });
await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
const client = new Client({ name: 'recorded-research-handoff-check', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.server.address().port}/mcp`)));
  const workspace = Object.values(JSON.parse(original).workspaces).find(w => w.reviewNotes?.some(n => n.verdict === 'rejected'));
  assert.ok(workspace, 'Recorded rejected assessment required');
  const note = workspace.reviewNotes.find(n => n.verdict === 'rejected');
  const before = fs.readFileSync(dataFile);
  for (const [name, extra] of [['multicontext_orchestrate_extract_findings', {}], ['multicontext_orchestrate_distill_context', {}], ['multicontext_orchestrate_distill_context', { chat_id: note.memberId }]]) {
    const result = await client.callTool({ name, arguments: { workspace_id: workspace.id, ...extra } });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = result.structuredContent;
    assert.equal(data.verificationStatus, 'UNREVIEWED');
    assert.ok(data.reviewNotes.some(n => n.id === note.id && n.rationale === note.rationale));
    assert.ok(result.content[0].text.includes(note.messageId));
    assert.ok(result.content[0].text.includes('rejected'));
    console.log(JSON.stringify({ tool: name, chat: extra.chat_id || null, reviewCount: data.reviewNotes.length, verification: data.verificationStatus }));
  }
  assert.deepEqual(fs.readFileSync(dataFile), before);
  assert.deepEqual(fs.readFileSync(source), original);
  console.log(JSON.stringify({ result: 'PASS', serverModule, originalState: 'UNCHANGED', modelRequests: 0, directory }));
} finally {
  await client.close();
  await new Promise(resolve => runtime.server.close(resolve));
}
