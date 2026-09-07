import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { LocalModelClient } from '../src/local-model.js';
import { Scheduler } from '../src/scheduler.js';
import { createApplication } from '../src/application.js';
const source = process.argv[2];
if (!source) throw new Error('Specify recorded experiment state.json');
const directory = path.resolve('data/experiments', `research-summary-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const statePath = path.join(directory, 'state.json');
fs.copyFileSync(source, statePath);
const store = new StateStore(statePath);
const client = new LocalModelClient({ directory: `${statePath}.local-conversations` });
const scheduler = new Scheduler({ store, client });
const app = createApplication({ config: { ...config, backend: 'local' }, store, client, scheduler });
scheduler.setApp(app);
const workspace = Object.values(store.state.workspaces)[0];
const agentId = (await client.listAgents())[0].id;
store.updateWorkspace(workspace.id, { compileAgentId: agentId });
const before = JSON.stringify(workspace.members);
console.log(JSON.stringify({ directory, workspaceId: workspace.id }));
try {
  await app.compile(workspace.id);
  assert.equal(JSON.stringify(store.getWorkspace(workspace.id).members), before);
  console.log(JSON.stringify({ directory, runtime: 'PASS', content: 'REQUIRES_REVIEW' }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.message }), { mode: 0o600 });
  throw error;
}
