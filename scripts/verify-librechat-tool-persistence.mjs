#!/usr/bin/env node
// Read-only source contract probe. Evaluates the controller's actual save
// function with an in-memory database stub; never connects to MongoDB.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import toolHistory from './librechat-tool-history.cjs';
import { createRequire } from 'node:module';
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-librechat-tool-persistence.mjs /path/to/LibreChat');
const source = fs.readFileSync(path.join(path.resolve(process.argv[2]), 'api/server/controllers/agents/responses.js'), 'utf8');
const start = source.indexOf('async function saveResponseOutput(');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start, 'supported controller persistence function must exist');
const saved = [];
const save = new Function('db', 'getLangfuseTraceMessageFields', 'EModelEndpoint',
  `${Object.values(toolHistory).map(fn => fn.toString()).join('\n')}\n${source.slice(start, end)}; return saveResponseOutput;`)(
  { saveMessage: async (_, message) => saved.push(message) },
  async () => ({}), { agents: 'agents' },
);
const response = {
  status: 'completed',
  output: [
    { type: 'function_call', call_id: 'persistence_probe', name: 'web_search', arguments: '{}' },
    { type: 'function_call_output', call_id: 'persistence_probe', output: 'PRIMARY_SOURCE_EVIDENCE_MARKER' },
    { type: 'message', content: [{ type: 'output_text', text: 'summary text' }] },
  ],
};
await save({ config: {} }, 'probe-conversation', 'probe-response', response, 'probe-agent', 1);
assert.equal(saved.length, 1);
assert.equal(saved[0].text, 'summary text');
assert.ok(JSON.stringify(saved).includes('PRIMARY_SOURCE_EVIDENCE_MARKER'),
  'Provider tool evidence is lost by saveResponseOutput; previous_response_id persistence is not verified');
console.log('Controller tool evidence persistence probe passed.');
if (process.argv[3]) {
  const runtimeRoot = path.resolve(process.argv[3]);
  const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
  const { formatAgentMessages } = requireRuntime(path.join(runtimeRoot, 'api/app/clients/prompts/formatMessages.js'));
  const replay = toolHistory.deduplicateToolHistory([
    { role: 'assistant', content: saved[0].content },
    { role: 'assistant', content: toolHistory.completedToolContent(response.output) },
  ]);
  const messages = formatAgentMessages(replay);
  assert.deepEqual(messages.map(message => message.getType()), ['ai', 'tool', 'ai']);
  assert.equal(messages[0].tool_calls[0].id, 'persistence_probe');
  assert.equal(messages[1].tool_call_id, 'persistence_probe');
  assert.equal(messages[1].content, 'PRIMARY_SOURCE_EVIDENCE_MARKER');
  console.log('Installed formatter replay passed: one call, one real output, then summary text.');
}
