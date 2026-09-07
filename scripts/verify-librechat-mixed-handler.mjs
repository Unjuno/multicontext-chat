#!/usr/bin/env node
// Contract integration, not a model/search E2E. Uses the installed LibreChat
// executor with deterministic tools; never touches credentials or live agents.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import mixed from './librechat-mixed-handler.cjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-librechat-mixed-handler.mjs /path/to/LibreChat');
const requireLibreChat = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
const { createToolExecuteHandler } = requireLibreChat('@librechat/api');
const sdk = requireLibreChat('@librechat/agents');
const sdkContent = requireLibreChat(path.join(path.dirname(requireLibreChat.resolve('@librechat/agents')), 'utils/toolContent.cjs'));
const serializeResult = mixed.createMixedResultSerializer({ ...sdk, ...sdkContent });
const circular = { label: 'cycle' };
circular.self = circular;
for (const content of ['', 'x'.repeat(5000), { snippets: ['x'.repeat(5000)] }, circular]) {
  const limit = 256;
  const expected = typeof content === 'string'
    ? sdk.truncateToolResultContent(content, limit)
    : sdkContent.serializeStructuredValueBounded(content, limit).content;
  assert.equal(serializeResult({ status: 'success', content }, { maxToolResultChars: limit }), expected);
}
assert.equal(serializeResult({ status: 'error', errorMessage: 'e'.repeat(5000) }, { maxToolResultChars: 256 }),
  sdk.truncateToolResultContent(`Error: ${'e'.repeat(5000)}\n Please fix your mistakes.`, 256));
const executed = [];
const loaded = [];
const ended = [];
const stock = createToolExecuteHandler({
  async loadTools(names) {
    loaded.push(...names);
    assert.ok(names.every(name => name.startsWith('audit_provider_')));
    return {
      loadedTools: names.map(name => ({
        name,
        async invoke(args) {
          executed.push({ name, args });
          return { content: name.endsWith('empty') ? '' : 'deterministic real executor result' };
        },
      })),
      configurable: {},
    };
  },
  async toolEndCallback(data) { ended.push(data); },
});
const aggregator = { toolOutputs: new Map() };
const handler = mixed.createMixedOwnershipHandler(stock, new Set(['send_to_chat']), aggregator, undefined, serializeResult);
let rejection;
await handler.handle('on_tool_execute', {
  agentId: 'audit-contract-agent',
  configurable: {},
  metadata: {},
  toolCalls: [
    { id: 'p1', name: 'audit_provider_text', args: { query: 'contract probe' } },
    { id: 'c1', name: 'send_to_chat', args: { targets: ['never-deliver'] } },
    { id: 'p2', name: 'audit_provider_empty', args: {} },
  ],
  resolve() { assert.fail('external batch must not resolve'); },
  reject(error) { rejection = error; },
});
assert.equal(rejection?.code, 'EXTERNAL_TOOL_DEFERRED', rejection?.stack);
assert.deepEqual(loaded, ['audit_provider_text', 'audit_provider_empty']);
assert.equal(executed.length, 2);
assert.equal(ended.length, 2);
assert.deepEqual([...aggregator.toolOutputs], [
  ['p1', 'deterministic real executor result'], ['p2', ''],
]);
console.log('Installed LibreChat executor mixed contract passed: 2 provider invocations, 0 cross-chat invocations; text and empty results preserved.');
console.log('Installed SDK serialization parity passed: empty, long text, structured, circular, and error results.');
