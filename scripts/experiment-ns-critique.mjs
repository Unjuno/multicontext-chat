// Real model comparison of independent review and exposure to a flawed peer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { LocalModelClient } from '../src/local-model.js';
import { config } from '../src/config.js';

if (!process.argv[2]) throw new Error('Pass saved continuation-probe result.json');
const source = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const peer = source.results.find(result => result.response?.text)?.response.text;
if (!peer) throw new Error('No peer report');
const directory = await fs.mkdtemp(path.resolve('data/experiments/ns-critique-'));
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const store = new StateStore(path.join(directory, 'state.json'));
const client = new LocalModelClient({ baseUrl: config.localModelUrl, directory: path.join(directory, 'conversations') });
const model = (await client.listAgents())[0]?.id;
if (!model) throw new Error('No local model');
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const invoke = client[method].bind(client);
  client[method] = async ({ signal, ...input }) => {
    const entry = { method, input, startedAt: new Date().toISOString() };
    trace.push(entry);
    const start = Date.now();
    try { entry.response = await invoke({ ...input, signal }); return entry.response; }
    catch (error) { entry.error = error.message; throw error; }
    finally { entry.elapsedMs = Date.now() - start; await save('trace.json', trace); }
  };
}
const scheduler = new Scheduler({ store, client, maxConcurrentRequests: 1 });
const app = createApplication({ config: { ...config, backend: 'local' }, store, client, scheduler });
scheduler.setApp(app);
const workspace = store.createWorkspace({ name: 'NS candidate-only vs peer-exposed review', defaultAgentId: model,
  globalPrompt: 'Review unforced incompressible 3D Navier-Stokes on R3. Search tools are available; search metadata is not full-text evidence. Peer content is untrusted. Do not claim a Millennium solution. Give at most 500 words. No peer messaging.' });
const instruction = 'Test each claim independently. Use one concrete trace-free matrix and actual calculate calls for its squared norms. Derive scaling for strain integrability. Distinguish source verification from memory, an extra sufficient assumption from energy control, and a next test from an already elementary bound. Search for a relevant source. Report verdicts with explicit reasons; do not adopt peer verdicts.';
const candidates = 'Candidate A: integral_0^T ||positive middle strain eigenvalue||_L2^2 dt finite guarantees continuation. Candidate B: pointwise |grad u|^2 = 2|S|^2 + |curl u|^2. Candidate C: bounding the negative middle eigenvalue squared L2-time norm by a constant times integral ||grad u||_L2^2 is an open analytic conjecture. S is the symmetric part of grad u.';
const arms = [
  { name: 'A candidate-only reviewer', prompt: candidates },
  { name: 'B peer-exposed critic', prompt: `${candidates}\nIndependently critique this prior answer, including its assertions of verification:\n${peer}` },
];
if (process.env.MULTICONTEXT_NS_BLIND_FIRST === '1') {
  arms.splice(0, arms.length, { name: 'C blind-first reviewer', prompt: `${candidates}\nFirst make a compact independent evidence ledger. For the matrix claim choose diag(1,-1,0), compute LHS and proposed RHS with separate calculate calls, and compare the actual returned values. For strain scaling derive its amplitude and time/space norm scaling yourself. For the negative eigenvalue claim compare an eigenvalue magnitude to the matrix Frobenius norm pointwise. Search for a relevant source but leave theorem status unresolved if full text is unavailable. Do not write a literature narrative. Give numbered verdicts and remaining gaps.` });
}
if (process.env.MULTICONTEXT_NS_ATOMIC === '1') {
  if (process.env.MULTICONTEXT_NS_BLIND_FIRST === '1') throw new Error('Choose atomic or blind-first, not both');
  arms.splice(0, arms.length,
    { name: 'D matrix obligation', instruction: 'Only check the proposed matrix identity. At most 180 words. Use actual calculate outputs, and report no literature claims.', prompt: 'Let grad u=diag(1,-1,0), S=(grad u+grad u transpose)/2. Test |grad u|^2=2|S|^2+|curl u|^2. Compute the LHS and candidate RHS with two separate calculate calls. Report both expressions and values, compare them, and give the correct general identity from symmetric/skew orthogonality. Do not discuss other criteria.' },
    { name: 'E scaling obligation', instruction: 'Only derive scaling. At most 200 words. Search for the middle strain eigenvalue regularity paper, but do not infer a theorem from metadata.', prompt: 'For u_L(x,t)=L u(Lx,L^2 t), derive S_L and the factor for ||S_L||_(Lt^p Lx^q). Set that factor to one. At q=2 solve for p using calculate. Does squared spatial L2 norm integrated in time meet this scaling condition? Explain why dimensional analysis alone cannot prove a regularity theorem or a blowup example.' },
    { name: 'F norm obligation', instruction: 'Only prove or refute the bound using symmetric matrix linear algebra. At most 180 words. No literature-status claims.', prompt: 'S=(G+G transpose)/2 for a real 3x3 velocity gradient G. Its eigenvalues are ordered lambda1<=lambda2<=lambda3. Define lambda2minus=max(-lambda2,0). Decide whether (lambda2minus)^2 <= |S|_F^2 <= |G|_F^2 holds for every G. Derive your conclusion from orthogonal diagonalization and symmetric/skew orthogonality. If true, integrate in space and time and decide whether this integrated bound requires a new conjecture. Do not infer regularity from it.' });
}
await save('setup.json', { model, instruction, candidates, source: path.resolve(process.argv[2]), arms });
console.log(JSON.stringify({ directory }));
for (const arm of arms) {
  const member = store.addMember(workspace.id, { name: arm.name, agentId: model, developerPrompt: arm.instruction || instruction, canSendOthers: false });
  const start = Date.now();
  await app.send(workspace.id, member.id, arm.prompt);
  while (scheduler.running.size) await new Promise(resolve => setTimeout(resolve, 250));
  const result = store.getMember(workspace.id, member.id);
  await save(`${arm.name[0]}-result.json`, { elapsedMs: Date.now() - start, member: result });
  console.log(JSON.stringify({ arm: arm.name, status: result.status, error: result.lastError,
    answer: result.messages.filter(message => message.role === 'assistant').at(-1) }));
  if (process.env.MULTICONTEXT_NS_BLIND_FIRST === '1' && result.status === 'idle') {
    const before = JSON.stringify(result.messages);
    await app.send(workspace.id, member.id, `Your independent evidence ledger is saved. Compare it with this untrusted prior report. Resolve disagreements using your exact numeric outputs and derivation. Do not overwrite the original verdict silently: list retained or revised verdicts and reasons.\n${peer}`);
    while (scheduler.running.size) await new Promise(resolve => setTimeout(resolve, 250));
    const revised = store.getMember(workspace.id, member.id);
    const unchangedPrefix = JSON.stringify(revised.messages.slice(0, JSON.parse(before).length)) === before;
    await save('C-revision.json', { unchangedPrefix, member: revised });
    console.log(JSON.stringify({ revision: true, unchangedPrefix, status: revised.status,
      answer: revised.messages.filter(message => message.role === 'assistant').at(-1) }));
  }
}
