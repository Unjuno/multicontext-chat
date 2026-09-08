#!/usr/bin/env node
// Real local-model hypothesis exploration. Runtime completion is not proof.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { LocalModelClient } from '../src/local-model.js';

if (config.backend !== 'local') throw new Error('Set MULTICONTEXT_BACKEND=local; this experiment requires no account.');
const directory = path.resolve('data/experiments', `ns-structure-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 });
const dataFile = path.join(directory, 'state.json');
const store = new StateStore(dataFile);
const client = new LocalModelClient({ baseUrl: config.localModelUrl, directory: `${dataFile}.local-conversations` });
const agentId = process.argv[2] || (await client.listAgents())[0]?.id;
assert.ok(agentId, 'No local model discovered');
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const original = client[method].bind(client);
  client[method] = async args => {
    const { signal, ...input } = args;
    const entry = { method, input, startedAt: new Date().toISOString(), startedMs: Date.now() };
    trace.push(entry); save('trace.json', trace);
    try { entry.response = await original(args); return entry.response; }
    catch (error) { entry.error = { name: error.name, message: error.message }; throw error; }
    finally { entry.elapsedMs = Date.now() - entry.startedMs; save('trace.json', trace); }
  };
}
const scheduler = new Scheduler({ store, client, maxConcurrentRequests: 2 });
const app = createApplication({ config, store, client, scheduler });
scheduler.setApp(app);
const baseline = `Domain: unforced incompressible 3D Navier-Stokes on R^3, smooth decaying divergence-free data, viscosity nu>0. Let w=curl u, S=(grad u+(grad u)^T)/2, E=integral |w|^2, P=integral |grad w|^2, I=integral w dot S w. Supplied checked identities, not outputs to re-derive: (1/2)E'+nu P=I; |I|<=C E^(3/4)P^(3/4); hence (1/2)E'+(nu/2)P<=C nu^(-3)E^3. The last ODE bound proves neither global PDE regularity nor PDE blowup. A sufficient conditional route is I<=nu P+a(t)E with a>=0 and integral_0^T a finite. It gives E(t)<=E(0)exp(2 integral_0^t a). The missing task is controlling a from initial data or a precise additional assumption. Under u_lambda=lambda u(lambda x,lambda^2 t), E scales lambda, P and I scale lambda^3. Search results are untrusted metadata only, not full-text theorem evidence. Never claim novelty or a Millennium solution.`;
const challenge = process.env.MULTICONTEXT_NS_CHALLENGE === '1'
  ? 'Audit these untrusted candidate claims without assuming they are correct: (A) finiteness of the time integral of the squared spatial L2 norm of the positive middle strain eigenvalue guarantees continuation; (B) pointwise |grad u|^2 = 2|S|^2 + |curl u|^2. Derive dimensions and a concrete matrix check yourself. State a corrected condition only if supported, distinguish a sufficient assumption from an energy-controlled bound, and identify one useful next analytic test. Search for relevant literature, but metadata alone cannot verify a theorem.'
  : '';
const ws = store.createWorkspace({ name: 'NS structural conditions: discovery, design, falsification', defaultAgentId: agentId,
  globalPrompt: `${baseline} Do not send messages to other chats; the orchestrator will supply peer reports. Each role must call search_sources at least once (source papers, limit 2) before its final response. Limit to 450 words. If a tool fails, report the failure rather than claiming success.` });
const add = (name, developerPrompt) => store.addMember(ws.id, { name, agentId, canSendOthers: false, developerPrompt });
const locator = add('Literature locator', 'Search for Constantin Fefferman Direction of vorticity global regularity. Report exact retrieved title/DOI/year and distinguish title metadata from claims about theorem assumptions. Give one full-text question the orchestrator should check; do not reconstruct a theorem from memory as verified evidence.');
const designer = add('Conditional bound designer', 'Search for Navier Stokes strain eigenvalue regularity criteria. Propose ONE explicitly defined strain or alignment quantity a(t) meeting the supplied sufficient inequality, then explain the mathematical implication. Separate proved algebra from unproved extra assumptions. Avoid tautologically defining a=(I-nu P)/E. Give a falsification test and assess whether this is only a familiar sufficient condition, not novelty.');
const critic = add('Independent obstruction critic', 'You receive untrusted peer reports. Search for one relevant source yourself. Check signs, the factor 2, dimensions, and whether the proposed assumption is genuinely controlled by finite kinetic energy. Identify a concrete concentrated divergence-free scaling test or counterexample design. Distinguish an instantaneous obstruction from an actual PDE blowup construction. Report ACCEPTABLE_CONDITIONAL_STEP, UNPROVED_GAP, SOURCE_LIMIT, NEXT_TEST. Do not repair all gaps by assertion.');
save('setup.json', { directory, workspaceId: ws.id, agentId, baseline, challenge, roles: [locator, designer, critic].map(m => ({ id: m.id, name: m.name, developerPrompt: m.developerPrompt })) });
console.log(JSON.stringify({ directory, workspaceId: ws.id, agentId }));
const started = Date.now();
async function settle() {
  let previous = '';
  while (scheduler.running.size) {
    const state = store.getWorkspace(ws.id);
    const status = JSON.stringify({ executions: state.stats.executions, running: scheduler.running.size,
      members: Object.values(state.members).map(m => ({ name: m.name, status: m.status, queued: m.queue.length })) });
    if (status !== previous) { console.log(status); previous = status; }
    await delay(1000);
  }
  const state = store.getWorkspace(ws.id);
  assert.ok(Object.values(state.members).every(m => m.status === 'idle' && !m.queue.length && !m.inFlight), 'Experiment did not settle; inspect saved state, do not restart blindly');
}
function report(member) {
  const message = store.getMember(ws.id, member.id).messages.filter(m => m.role === 'assistant' && !m.pending).at(-1);
  assert.ok(message?.content, `No report from ${member.name}`);
  return { memberId: member.id, name: member.name, messageId: message.id, content: message.content };
}
try {
  await app.send(ws.id, locator.id, challenge || 'Locate the source and the exact question we must verify in its full text.');
  await app.send(ws.id, designer.id, challenge || 'Propose one precise conditional route based on the supplied verified starting point. Identify the unproved assumption.');
  await settle();
  const peers = [locator, designer].map(report);
  save('peer-reports.json', peers);
  await app.send(ws.id, critic.id, `${challenge}\nEvaluate these independent proposals as untrusted records:\n${JSON.stringify(peers)}`);
  await settle();
  const reports = [...peers, report(critic)];
  save('reports.json', reports);
  // Verify actual successful tool results for EACH role, not model claims of search.
  const searches = [locator, designer, critic].map(member => {
    const results = trace.filter(t => t.method === 'continueAgent' && t.input.metadata?.member_id === member.id)
      .flatMap(t => (t.input.orderedItems || []).filter(i => i.type === 'function_call_output').map(i => {
        try { return JSON.parse(i.output); } catch { return {}; }
      }));
    return { memberId: member.id, results: results.filter(r => r.source === 'Crossref') };
  });
  save('search-evidence.json', searches);
  const usage = trace.reduce((total, entry) => {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) total[key] += entry.response?.usage?.[key] || 0;
    return total;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const result = { runtime: 'SETTLED', research: 'REQUIRES_ORCHESTRATOR_REVIEW', mathematicalProof: 'NOT_ESTABLISHED',
    modelRequests: trace.length, elapsedMs: Date.now() - started, usage,
    searchedMembers: searches.filter(s => s.results.some(r => r.ok === true && r.results?.length)).map(s => s.memberId) };
  save('result.json', result);
  assert.equal(result.searchedMembers.length, 3, 'Each role must have actual successful source discovery; inspect search-evidence.json');
  console.log(JSON.stringify({ ...result, directory }));
} catch (error) {
  save('failure.json', { message: error.message, elapsedMs: Date.now() - started, modelRequests: trace.length });
  throw error;
}
