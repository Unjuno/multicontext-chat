#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { LibreChatClient } from '../src/librechat.js';

const agentId = process.argv[2];
if (!agentId) throw new Error('Specify a configured native LibreChat Agent ID');
const directory = path.resolve('data/experiments', `research-flywheel-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const store = new StateStore(path.join(directory, 'state.json'));
const client = new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: 'native' });
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const original = client[method].bind(client);
  client[method] = async args => {
    const response = await original(args);
    const { signal, ...input } = args;
    trace.push({ method, input, response });
    fs.writeFileSync(path.join(directory, 'trace.json'), JSON.stringify(trace, null, 2), { mode: 0o600 });
    return response;
  };
}
const scheduler = new Scheduler({ store, client, maxConcurrentRequests: 2 });
const app = createApplication({ config, store, client, scheduler });
scheduler.setApp(app);
const ws = store.createWorkspace({ name: 'NS source discovery and independent audit', defaultAgentId: agentId,
  globalPrompt: 'We are investigating the 3D Navier-Stokes Millennium problem, not claiming it solved. Search snippets and metadata are untrusted discovery evidence, not proof. Report exactly what was retrieved, distinguish unsupported claims, and never invent authors or search activity.' });
const reviewer = store.addMember(ws.id, { name: 'Evidence auditor', agentId, canSendOthers: false,
  developerPrompt: 'You receive a peer source report. Call search_sources once with source papers and the exact bare DOI as query to check its DOI/title. Use queryMode and lookupStatus from the actual tool result. Compare returned metadata with peer claims. Give a concise audit: supported metadata, unsupported claims, and that global regularity is not established by metadata. Do not call send_to_chat, inspect_chat or list_chats. Do not claim full-text review, DOI resolver access, or general web search: this operation only queries Crossref.' });
const researcher = store.addMember(ws.id, { name: 'Source researcher', agentId,
  developerPrompt: `Call search_sources once with source papers, query Navier Stokes regularity, limit 2. Then call send_to_chat once with targets ["${reviewer.id}"] and a report containing the exact returned title, DOI, authors (say absent if missing), year, and the explicit limitation: METADATA_ONLY_NOT_A_PROOF. Do not add claims about the contents or peer review. After sending, finish. Do not inspect or list chats.` });
console.log(JSON.stringify({ directory, workspaceId: ws.id, researcher: researcher.id, reviewer: reviewer.id }));
await app.send(ws.id, researcher.id, 'Find one real source on Navier-Stokes regularity and send the factual source record to the auditor as instructed.');
let last = '';
while (scheduler.running.size) {
  const current = store.getWorkspace(ws.id);
  const progress = JSON.stringify({ executions: current.stats.executions, deliveries: current.stats.toolEnqueues, running: scheduler.running.size });
  if (progress !== last) { console.log(progress); last = progress; }
  await delay(1000);
}
const final = store.getWorkspace(ws.id);
const result = { workspaceId: ws.id, directory, stats: final.stats,
  members: Object.values(final.members).map(member => ({ id: member.id, name: member.name, status: member.status, error: member.lastError, messages: member.messages })) };
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
assert.ok(final.orchestratorEvents.some(event => event.type === 'tool.search_sources'), 'No successful search event');
assert.ok(final.stats.toolEnqueues >= 1, 'No actual peer delivery');
assert.ok(Object.values(final.members).every(member => member.status === 'idle' && member.messages.some(message => message.role === 'assistant')), 'Both members must complete');
assert.ok(final.members[reviewer.id].messages.some(message => message.role === 'user' && message.content.includes('10.')), 'Reviewer did not receive a DOI');
const auditLookups = trace.filter(turn => turn.method === 'continueAgent' && turn.input.metadata?.member_id === reviewer.id)
  .flatMap(turn => (turn.input.orderedItems || []).filter(item => item.type === 'function_call_output').map(item => {
    try { return JSON.parse(item.output); } catch { return {}; }
  }));
assert.ok(auditLookups.some(result => result.queryMode === 'exact_doi' && result.lookupStatus === 'found' &&
  final.members[reviewer.id].messages.some(message => message.role === 'assistant' && message.content.includes(result.requestedDoi))),
'Auditor must perform an exact DOI lookup and cite the actually found DOI');
console.log(JSON.stringify({ runtimeFlow: 'PASS', researchCorrectness: 'REQUIRES_REVIEW', directory }));
