// Continue the saved scaling member in an isolated copy, retaining its failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { StateStore } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
import { LocalModelClient } from '../src/local-model.js';
import { config } from '../src/config.js';
if (!process.argv[2]) throw new Error('Pass atomic experiment directory');
const source = path.resolve(process.argv[2]);
const directory = await fs.mkdtemp(path.resolve('data/experiments/ns-scaling-intervention-'));
await fs.copyFile(path.join(source, 'state.json'), path.join(directory, 'state.json'));
await fs.cp(path.join(source, 'conversations'), path.join(directory, 'conversations'), { recursive: true });
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const store = new StateStore(path.join(directory, 'state.json'));
const workspace = Object.values(store.state.workspaces)[0];
const member = Object.values(workspace.members).find(m => m.name === 'E scaling obligation');
assert.ok(member && member.status === 'idle' && !member.queue.length);
const original = structuredClone(member.messages);
const client = new LocalModelClient({ baseUrl: config.localModelUrl, directory: path.join(directory, 'conversations') });
const trace = [];
for (const method of ['runAgent', 'continueAgent']) {
  const invoke = client[method].bind(client);
  client[method] = async ({ signal, ...input }) => {
    const entry = { method, input, startedAt: new Date().toISOString() };
    trace.push(entry);
    try { entry.response = await invoke({ ...input, signal }); return entry.response; }
    catch (error) { entry.error = error.message; throw error; }
    finally { await save('trace.json', trace); }
  };
}
const scheduler = new Scheduler({ store, client });
const app = createApplication({ config: { ...config, backend: 'local' }, store, client, scheduler });
scheduler.setApp(app);
const prompt = 'Your prior scaling derivation contains sign errors. Correct it from definitions, without copying your previous exponent. Start with u_L(x,t)=L*u(L*x,L^2*t). (1) Apply the chain rule to one x derivative, retaining both factors of L. (2) In the spatial integral set y=L*x and write dx in terms of dy. (3) In the time integral set s=L^2*t and write dt in terms of ds. Combine the resulting powers for the Lt^p Lx^q norm of S_L. (4) Set the exponent to zero, solve p at q=2 using an actual calculate call, then substitute the returned p into the exponent with another calculate call. Report the corrected formula, exact tool values, and which prior claims you retract. Work on transformed time intervals; do not claim this proves regularity. No new search is required for this algebra-only correction.';
await save('setup.json', { source, workspaceId: workspace.id, memberId: member.id, prompt });
console.log(JSON.stringify({ directory }));
await app.send(workspace.id, member.id, prompt);
while (scheduler.running.size) await new Promise(resolve => setTimeout(resolve, 250));
const current = store.getMember(workspace.id, member.id);
assert.deepEqual(current.messages.slice(0, original.length), original);
const result = { status: current.status, error: current.lastError, originalPrefixUnchanged: true,
  answer: current.messages.filter(m => m.role === 'assistant').at(-1) };
await save('result.json', result);
console.log(JSON.stringify(result));
