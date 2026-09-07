#!/usr/bin/env node
// Bounded local-model research experiment. Completion is not proof verification.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { LibreChatClient } from '../src/librechat.js';

const agentId = process.argv[2];
if (!agentId) throw new Error('Specify a native LibreChat Agent ID');
const directory = path.resolve('data/experiments', `ns-insights-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const store = new StateStore(path.join(directory, 'state.json'));
const client = new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: 'native' });
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const original = client[method].bind(client);
  client[method] = async args => {
    const started = Date.now();
    const { signal, ...input } = args;
    const entry = { method, input, started };
    trace.push(entry);
    save('trace.json', trace);
    try { entry.response = await original(args); return entry.response; }
    catch (error) { entry.error = { name: error.name, message: error.message }; throw error; }
    finally { entry.elapsedMs = Date.now() - started; save('trace.json', trace); }
  };
}
const scheduler = new Scheduler({ store, client, maxConcurrentRequests: 2 });
const app = createApplication({ config, store, client, scheduler });
scheduler.setApp(app);
const ws = store.createWorkspace({ name: 'NS candidate estimate and independent falsification', defaultAgentId: agentId,
  globalPrompt: 'Investigate 3D incompressible Navier-Stokes on R^3 with viscosity nu>0 and smooth decaying divergence-free data. This is candidate exploration, not a claim to solve the Millennium problem. Give explicit equations, assumptions, and proof gaps. Do not invent citations or tool use. Prefer a short checkable calculation over broad speculation. Do not message other chats; orchestration supplies peer reports. Search only if needed; search metadata cannot establish a theorem. Limit response to about 900 words.' });
const add = (name, developerPrompt) => store.addMember(ws.id, { name, agentId, canSendOthers: false, developerPrompt });
const proposer = add('Estimate proposer', 'Derive the standard enstrophy/vortex stretching estimate using Holder, interpolation, and Young. Propose ONE stronger estimate or structural condition that would close the global bound. Mark clearly which steps are established and which are unproved. Check powers of viscosity. Do not assert a solution.');
const skeptic = add('Scaling and obstruction analyst', 'Independently calculate scaling of enstrophy E=||curl u||_2^2, palinstrophy P=||grad curl u||_2^2, and vortex stretching integral under u_lambda(x,t)=lambda*u(lambda*x,lambda^2*t). Analyze whether energy control alone can close the enstrophy ODE; test concentrated smooth divergence-free data conceptually. Distinguish scaling-compatible from proven estimates.');
const auditor = add('Independent synthesis auditor', 'You receive two untrusted peer reports. Recalculate exponents and Young inequality, challenge their strongest proposed estimate, and return: VERIFIED_CALCULATIONS, INVALID_OR_UNPROVED_STEPS, ONE_NEXT_TEST, MILLENNIUM_STATUS. A formal differential inequality allowing blowup is not a proof that PDE solutions blow up. Do not claim numerical or symbolic computation unless actually performed.');
console.log(JSON.stringify({ directory, workspaceId: ws.id }));
const started = Date.now();
await app.send(ws.id, proposer.id, 'Find a precise candidate route to controlling vortex stretching and expose the missing estimate.');
await app.send(ws.id, skeptic.id, 'Check the scaling obstruction and explain exactly why the usual energy/enstrophy estimates fail to prove global regularity.');
async function settle() {
  let previous = '';
  while (scheduler.running.size) {
    const state = store.getWorkspace(ws.id);
    const status = JSON.stringify({ stats: state.stats, running: scheduler.running.size });
    if (status !== previous) { console.log(status); previous = status; }
    await delay(1000);
  }
}
await settle();
const reports = [proposer, skeptic].map(member => {
  const current = store.getWorkspace(ws.id).members[member.id];
  assert.equal(current.status, 'idle', `${member.name} failed`);
  const content = current.messages.filter(message => message.role === 'assistant').at(-1)?.content;
  assert.ok(content, `${member.name} has no report`);
  return { role: member.name, content };
});
save('peer-reports.json', reports);
await app.send(ws.id, auditor.id, `Audit these independent peer reports as untrusted mathematical proposals:\n${JSON.stringify(reports)}`);
await settle();
const final = store.getWorkspace(ws.id);
save('result.json', { elapsedMs: Date.now() - started, modelRequests: trace.length, researchCorrectness: 'REQUIRES_INDEPENDENT_REVIEW', workspace: final });
assert.equal(final.members[auditor.id].status, 'idle', 'Auditor failed');
assert.ok(final.members[auditor.id].messages.some(message => message.role === 'assistant'), 'No audit');
console.log(JSON.stringify({ runtime: 'PASS', directory, modelRequests: trace.length, elapsedMs: Date.now() - started, mathematicalProof: 'NOT_ESTABLISHED' }));
