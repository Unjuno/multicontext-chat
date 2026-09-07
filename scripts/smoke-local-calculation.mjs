import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LocalModelClient } from '../src/local-model.js';
import { CrossChatToolExecutor, extractToolCalls, buildOrderedContinuation } from '../src/cross-chat-executor.js';

const directory = path.resolve('data/experiments', `local-calculation-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const client = new LocalModelClient({ directory: path.join(directory, 'conversations') });
const agentId = (await client.listAgents())[0]?.id;
const evidence = { directory, status: 'RUNNING' };
const save = () => fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ directory }));
try {
  const developerPrompt = 'Use calculate, not mental arithmetic. Compute exactly the requested expression once. After its output, report the numeric result and say this checks arithmetic only, not a Navier-Stokes proof. No other tools.';
  const initial = await client.runAgent({ agentId, developerPrompt, prompt: 'Calculate 1/(1-3/4) to check the conjugate Young exponent.' });
  evidence.initial = initial; save();
  const calls = extractToolCalls(initial.raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'calculate');
  const results = await new CrossChatToolExecutor({ app: {} }).execute({ toolCalls: calls });
  evidence.results = results; save();
  assert.equal(JSON.parse(results[0].output).value, 4);
  evidence.final = await client.continueAgent({ agentId, developerPrompt, conversationId: initial.conversationId, orderedItems: buildOrderedContinuation(initial.raw, results) });
  assert.equal(extractToolCalls(evidence.final.raw).length, 0);
  assert.match(evidence.final.text, /\b4\b/);
  evidence.status = 'PASS';
  console.log(JSON.stringify({ directory, status: evidence.status }));
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.message; throw error; }
finally { save(); }
