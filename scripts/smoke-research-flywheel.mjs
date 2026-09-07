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
import { LocalModelClient } from '../src/local-model.js';

const agentId = process.argv[2];
if (!agentId) throw new Error('Specify a configured native LibreChat Agent ID');
const calculatorProbe = process.argv.includes('--calculator');
const directory = path.resolve('data/experiments', `research-flywheel-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const store = new StateStore(path.join(directory, 'state.json'));
const client = config.backend === 'local'
  ? new LocalModelClient({ baseUrl: config.localModelUrl, directory: path.join(directory, 'conversations') })
  : new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: 'native' });
if (calculatorProbe && config.backend === 'local') throw new Error('--calculator tests LibreChat provider ownership, not the local backend');
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
  developerPrompt: `${calculatorProbe ? 'First call the LibreChat calculator tool to calculate 17*19. Use its actual output, not mental arithmetic. Then proceed to the search and include the calculator result in your peer report. ' : ''}Call search_sources once with source papers, query Navier Stokes regularity, limit 2. Then call send_to_chat once with targets ["${reviewer.id}"] and a report containing the exact returned title, DOI, authors (say absent if missing), year, and the explicit limitation: METADATA_ONLY_NOT_A_PROOF. Do not add claims about the contents or peer review. After sending, finish. Do not inspect or list chats.` });
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
if (config.backend === 'local') {
  assert.ok(Object.values(final.members).every(member => member.messages.some(message =>
    message.role === 'assistant' && message.searchEvidence?.succeeded > 0 && message.searchEvidence.fullTextVerified === false)),
  'Both local research roles must retain actual search evidence, without claiming full-text verification');
}
assert.ok(final.members[reviewer.id].messages.some(message => message.role === 'user' && message.content.includes('10.')), 'Reviewer did not receive a DOI');
const auditLookups = trace.filter(turn => turn.method === 'continueAgent' && turn.input.metadata?.member_id === reviewer.id)
  .flatMap(turn => (turn.input.orderedItems || []).filter(item => item.type === 'function_call_output').map(item => {
    try { return JSON.parse(item.output); } catch { return {}; }
  }));
assert.ok(auditLookups.some(result => result.queryMode === 'exact_doi' && result.lookupStatus === 'found' &&
  final.members[reviewer.id].messages.some(message => message.role === 'assistant' && message.content.includes(result.requestedDoi))),
'Auditor must perform an exact DOI lookup and cite the actually found DOI');
if (calculatorProbe) {
  // Calculator MUST be configured on the saved Agent. Supplying it as a
  // request-level function would instead make it caller-owned in this protocol.
  const researcherTurns = trace.filter(turn => turn.input.metadata?.member_id === researcher.id);
  const mixedTurn = researcherTurns.find(turn => {
    const items = turn.response.raw?.output || [];
    return items.some(item => item.type === 'function_call' && item.name === 'calculator' &&
      items.some(output => output.type === 'function_call_output' && output.call_id === item.call_id && String(output.output).includes('323'))) &&
      items.some(item => item.type === 'function_call' && ['search_sources', 'send_to_chat'].includes(item.name));
  });
  assert.ok(mixedTurn, 'No aggregated provider calculator result plus external call observed; mixed path NOT VERIFIED');
  const providerCall = mixedTurn.response.raw.output.find(item => item.type === 'function_call' && item.name === 'calculator');
  const nextTurn = researcherTurns[researcherTurns.indexOf(mixedTurn) + 1];
  assert.equal(nextTurn?.method, 'continueAgent', 'No native continuation after mixed result');
  assert.equal(nextTurn.input.conversationId, mixedTurn.response.conversationId, 'Native continuity broken');
  const replay = nextTurn.input.orderedItems || [];
  assert.equal(replay.filter(item => item.type === 'function_call_output' && item.call_id === providerCall.call_id).length, 1,
    'Provider result missing or duplicated in continuation');
  assert.ok(!JSON.stringify(trace).includes('UNKNOWN_TOOL'), 'Unknown tool result in mixed run');
  console.log(JSON.stringify({ sequentialMixedEvidence: 'PASS', sameStepMixed: 'NOT_VERIFIED', providerWire: 'NOT_CAPTURED' }));
}
console.log(JSON.stringify({ runtimeFlow: 'PASS', researchCorrectness: 'REQUIRES_REVIEW', directory }));
