import test from 'node:test';
import assert from 'node:assert/strict';
import mixed from '../scripts/librechat-mixed-handler.cjs';

test('mixed serializer requires SDK functions and forwards the agent result limit', () => {
  assert.throws(() => mixed.createMixedResultSerializer({}), /Unsupported LibreChat SDK/);
  const limits = [];
  const serialize = mixed.createMixedResultSerializer({
    calculateMaxToolResultChars(tokens) { return tokens * 2; },
    truncateToolResultContent(content, limit) { limits.push(limit); return content.slice(0, limit); },
    serializeStructuredValueBounded(content, limit) { limits.push(limit); return { content: 'bounded' }; },
  });
  assert.equal(serialize({ content: 'abcdef' }, { maxToolResultChars: 3 }), 'abc');
  assert.equal(serialize({ content: {} }, { maxContextTokens: 5 }), 'bounded');
  assert.deepEqual(limits, [3, 10]);
});

for (const providerName of ['web_search', 'librechat_mcp', 'code_execution']) {
  test(`mixed adapter runs ${providerName} only inside the stock handler`, async () => {
    const seen = [];
    const aggregator = { toolOutputs: new Map() };
    const handler = mixed.createMixedOwnershipHandler({
      async handle(event, data) {
        seen.push(...data.toolCalls.map(call => call.name));
        assert.equal(data.onResult, undefined);
        data.resolve(data.toolCalls.map(call => ({ toolCallId: call.id, status: 'success', content: `real:${call.id}` })));
      },
    }, new Set(['send_to_chat', 'inspect_chat']), aggregator);
    let rejection;
    await handler.handle('execute', {
      toolCalls: [
        { id: 'p1', name: providerName }, { id: 'c1', name: 'send_to_chat' },
        { id: 'p2', name: providerName }, { id: 'c2', name: 'inspect_chat' },
      ],
      resolve() { assert.fail('external batch must remain unresolved'); },
      reject(error) { rejection = error; },
    });
    assert.deepEqual(seen, [providerName, providerName]);
    assert.deepEqual([...aggregator.toolOutputs], [['p1', 'real:p1'], ['p2', 'real:p2']]);
    assert.equal(rejection.code, 'EXTERNAL_TOOL_DEFERRED');
    assert.deepEqual(rejection.toolNames, ['send_to_chat', 'inspect_chat']);
  });
}

test('provider-only data is passed through without replacing graph callbacks', async () => {
  const data = { toolCalls: [{ id: 'p', name: 'web_search' }] };
  let received;
  const handler = mixed.createMixedOwnershipHandler({ handle: async (_, value) => { received = value; } }, new Set(), {});
  await handler.handle('execute', data);
  assert.equal(received, data);
});

test('cross-only batch never invokes the stock executor', async () => {
  let rejection;
  await mixed.createMixedOwnershipHandler({ handle() { assert.fail(); } }, new Set(['send_to_chat']), {}).handle('execute', {
    toolCalls: [{ id: 'c', name: 'send_to_chat' }], reject(error) { rejection = error; },
  });
  assert.equal(rejection.code, 'EXTERNAL_TOOL_DEFERRED');
});

test('missing results fail without storing partial output or deferring deliveries', async () => {
  const aggregator = { toolOutputs: new Map() };
  let rejection;
  await mixed.createMixedOwnershipHandler({ handle: async (_, data) => data.resolve([]) }, new Set(['send_to_chat']), aggregator).handle('execute', {
    toolCalls: [{ id: 'p', name: 'web_search' }, { id: 'c', name: 'send_to_chat' }],
    reject(error) { rejection = error; },
  });
  assert.match(rejection.message, /Missing provider/);
  assert.notEqual(rejection.code, 'EXTERNAL_TOOL_DEFERRED');
  assert.equal(aggregator.toolOutputs.size, 0);
});

test('cancellation during provider execution prevents external deferral', async () => {
  const abort = new AbortController();
  let rejection;
  const aggregator = { toolOutputs: new Map() };
  await mixed.createMixedOwnershipHandler({ handle: async (_, data) => {
    abort.abort(new Error('cancelled'));
    data.resolve([{ toolCallId: 'p', status: 'success', content: '' }]);
  } }, new Set(['send_to_chat']), aggregator, abort.signal).handle('execute', {
    toolCalls: [{ id: 'p', name: 'web_search' }, { id: 'c', name: 'send_to_chat' }],
    reject(error) { rejection = error; },
  });
  assert.equal(rejection.message, 'cancelled');
  assert.equal(aggregator.toolOutputs.size, 0);
});

for (const ids of [['p', 'p', 'c'], ['p', 'q', 'p'], ['', 'q', 'c'], ['p', 'q', undefined]]) {
  test(`invalid mixed call identities fail before provider execution: ${JSON.stringify(ids)}`, async () => {
    let rejection;
    let executions = 0;
    const aggregator = { toolOutputs: new Map() };
    const handler = mixed.createMixedOwnershipHandler({ handle() { executions++; } }, new Set(['send_to_chat']), aggregator);
    await handler.handle('execute', {
      toolCalls: ids.map((id, index) => ({ id, name: index === 2 ? 'send_to_chat' : 'web_search' })),
      reject(error) { rejection = error; },
    });
    assert.match(rejection.message, /mixed tool call identity/);
    assert.equal(executions, 0);
    assert.equal(aggregator.toolOutputs.size, 0);
    assert.notEqual(rejection.code, 'EXTERNAL_TOOL_DEFERRED');
  });
}
