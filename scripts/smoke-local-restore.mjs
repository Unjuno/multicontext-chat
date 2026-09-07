#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LocalModelClient } from '../src/local-model.js';
import { createLocalBackup } from '../src/backup.js';
import { CrossChatToolExecutor, extractToolCalls, buildOrderedContinuation } from '../src/cross-chat-executor.js';

const directory = path.resolve('data/experiments', `local-restore-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const dataFile = path.join(directory, 'state.json');
const client = new LocalModelClient({ directory: `${dataFile}.local-conversations` });
const agentId = process.argv[2] || (await client.listAgents())[0]?.id;
assert.ok(agentId, 'No local model');
const evidence = { agentId, directory, turns: [], status: 'RUNNING' };
const persist = () => fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ directory, agentId }));
const instruction = 'Call search_sources exactly once with source papers and query Navier Stokes regularity, limit 1. After the result give its exact title and DOI, stating metadata is not proof. Do not call any chat tools.';
try {
  const initial = await client.runAgent({ agentId, developerPrompt: instruction, prompt: 'Find a source using the search tool now.' });
  evidence.turns.push(initial); persist();
  const calls = extractToolCalls(initial.raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_sources');
  const state = { conversationId: initial.conversationId, pendingCalls: calls };
  const backup = createLocalBackup({ dataFile, scheduler: { running: new Map() },
    store: { save() { fs.writeFileSync(dataFile, JSON.stringify(state), { mode: 0o600 }); } } });
  evidence.backup = backup; persist();
  const originalTranscript = fs.readFileSync(client.file(initial.conversationId), 'utf8');
  const restoredFile = path.join(directory, 'restored-state.json');
  fs.copyFileSync(path.join(backup.path, 'state.json'), restoredFile);
  fs.cpSync(path.join(backup.path, 'conversations'), `${restoredFile}.local-conversations`, { recursive: true });
  const restoredState = JSON.parse(fs.readFileSync(restoredFile));
  const restored = new LocalModelClient({ directory: `${restoredFile}.local-conversations` });
  const outputs = await new CrossChatToolExecutor({ app: {} }).execute({ toolCalls: restoredState.pendingCalls });
  const source = JSON.parse(outputs[0].output);
  assert.equal(source.ok, true);
  assert.ok(source.results?.length);
  evidence.toolOutputs = outputs; persist();
  const final = await restored.continueAgent({ agentId, conversationId: restoredState.conversationId, developerPrompt: instruction,
    orderedItems: buildOrderedContinuation(initial.raw, outputs) });
  evidence.turns.push(final); persist();
  assert.equal(extractToolCalls(final.raw).length, 0, 'Unexpected extra tool round');
  assert.ok(source.results.some(result => result.doi && final.text.includes(result.doi)), 'No citation to restored search evidence');
  assert.equal(fs.readFileSync(client.file(initial.conversationId), 'utf8'), originalTranscript, 'Original conversation changed');
  evidence.status = 'PASS';
  evidence.scope = 'REAL_MODEL_PENDING_SEARCH_RESTORE_NOT_FULL_GUI_OR_SCHEDULER_RECOVERY';
  console.log(JSON.stringify({ status: evidence.status, directory }));
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error.message; throw error;
} finally { persist(); }
