import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderedContinuation, assertProviderResultsComplete } from '../src/cross-chat-executor.js';

test('unresolved provider work is rejected before external dispatch', () => {
  const call = { type: 'function_call', call_id: 'p', name: 'web_search', arguments: '{}' };
  assert.throws(() => assertProviderResultsComplete({ output: [call] }), { code: 'PROVIDER_TOOL_RESULT_MISSING' });
  assert.doesNotThrow(() => assertProviderResultsComplete({ output: [call,
    { type: 'function_call_output', call_id: 'p', output: 'real result' }] }));
});

test('sequential provider output retains its position and occurs exactly once', () => {
  const a = { type: 'function_call', call_id: 'a', name: 'web_search', arguments: '{}' };
  const output = { type: 'function_call_output', call_id: 'a', output: 'real search result' };
  const b = { type: 'function_call', call_id: 'b', name: 'send_to_chat', arguments: '{}' };
  assert.deepEqual(buildOrderedContinuation({ output: [a, output, b] }, [{ call_id: 'b', output: 'receipt' }]),
    [a, output, b, { type: 'function_call_output', call_id: 'b', output: 'receipt' }]);
});

test('existing outputs are not moved across other calls or replaced by supplied results', () => {
  const items = [
    { type: 'function_call', call_id: 'a', name: 'web_search', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'code_execution', arguments: '{}' },
    { type: 'function_call_output', call_id: 'b', output: 'code' },
    { type: 'function_call_output', call_id: 'a', output: 'search' },
  ];
  assert.deepEqual(buildOrderedContinuation({ output: items }, [{ call_id: 'a', output: 'incorrect' }]), items);
});
