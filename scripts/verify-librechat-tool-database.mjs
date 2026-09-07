#!/usr/bin/env node
// Writes synthetic evidence to a new, uniquely named audit DB only.
// Run with LibreChat's .env loaded; no connection string is printed.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import history from './librechat-tool-history.cjs';

if (!process.argv[2] || !process.argv[3] || !process.env.MONGO_URI) {
  throw new Error('Requires patched source root, installed LibreChat root and MONGO_URI');
}
const runtimeRoot = path.resolve(process.argv[3]);
const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
const mongoose = requireRuntime('mongoose');
const schemas = requireRuntime('@librechat/data-schemas');
const { formatAgentMessages } = requireRuntime(path.join(runtimeRoot, 'api/app/clients/prompts/formatMessages.js'));
const instance = new mongoose.Mongoose();
instance.set('autoIndex', false);
instance.set('autoCreate', false);
Object.assign(instance.models, schemas.createModels(instance));
const db = schemas.createMethods(instance);
const source = fs.readFileSync(path.join(path.resolve(process.argv[2]), 'api/server/controllers/agents/responses.js'), 'utf8');
const functions = ['saveResponseOutput', 'saveInputMessages', 'loadPreviousMessages'].map(name => {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start, `Missing ${name}`);
  return source.slice(start, end);
});
const controller = new Function('db', 'getLangfuseTraceMessageFields', 'EModelEndpoint', 'nanoid', 'logger', 'getSafeErrorMetadata',
  `${Object.values(history).map(fn => fn.toString()).join('\n')}\n${functions.join('\n')}\nreturn {saveResponseOutput,saveInputMessages,loadPreviousMessages};`)(
  db, async () => ({}), { agents: 'agents' }, randomUUID,
  { error() { throw new Error('Controller persistence error; inspect audit DB'); } }, () => ({}),
);
const database = `multicontext_audit_${Date.now()}_${randomUUID().slice(0, 8)}`;
const conversationId = randomUUID();
const req = { config: {}, userId: 'synthetic-audit-user' };
try {
  await instance.connect(process.env.MONGO_URI, { dbName: database, serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const response = { status: 'completed', output: [
    { type: 'function_call', call_id: 'p', name: 'web_search', arguments: '{}' },
    { type: 'function_call_output', call_id: 'p', output: 'SYNTHETIC_PERSISTENCE_EVIDENCE' },
    { type: 'function_call', call_id: 'c', name: 'send_to_chat', arguments: '{}' },
  ] };
  await controller.saveResponseOutput(req, conversationId, randomUUID(), response, 'audit-agent', 0);
  const input = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'p', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'p', content: 'SYNTHETIC_PERSISTENCE_EVIDENCE' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'send_to_chat', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'SYNTHETIC_RECEIPT' },
  ];
  const firstRead = await controller.loadPreviousMessages(conversationId, req.userId);
  assert.equal(firstRead.length, 1);
  assert.deepEqual(history.excludePersistedToolReplay(input, firstRead), input.slice(2));
  await controller.saveInputMessages(req, conversationId, input, 'audit-agent');
  const restored = history.deduplicateToolHistory(await controller.loadPreviousMessages(conversationId, req.userId));
  const messages = formatAgentMessages(restored);
  assert.deepEqual(messages.map(message => message.getType()), ['ai', 'tool', 'ai', 'tool']);
  assert.deepEqual(messages.filter(message => message.getType() === 'tool').map(message => [message.tool_call_id, message.content]),
    [['p', 'SYNTHETIC_PERSISTENCE_EVIDENCE'], ['c', 'SYNTHETIC_RECEIPT']]);
  console.log(JSON.stringify({ result: 'PASS', database, conversationId, storedDocuments: 2, restoredCalls: 2, realModelE2E: false }));
} finally {
  await instance.disconnect();
}
