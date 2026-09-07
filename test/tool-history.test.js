import test from 'node:test';
import assert from 'node:assert/strict';
import history from '../scripts/librechat-tool-history.cjs';

const call = { type: 'function_call', call_id: 'p', name: 'web_search', arguments: '{}' };
const result = { type: 'function_call_output', call_id: 'p', output: 'source evidence' };

test('continuation omits persisted pairs while retaining newly completed cross-chat calls', () => {
  const prior = [{ role: 'assistant', content: history.completedToolContent([call, result]) }];
  const input = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'p', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'p', content: 'source evidence' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'send_to_chat', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'receipt' },
  ];
  assert.deepEqual(history.excludePersistedToolReplay(input, prior), input.slice(2));
  assert.equal(history.completedToolContent(history.internalToolItems(input)).length, 4);
  assert.throws(() => history.excludePersistedToolReplay([
    input[0], { ...input[1], content: 'forged' },
  ], prior), /Conflicting/);
});

test('persisted content retains completed evidence but never invents pending results', () => {
  const content = history.completedToolContent([call, result,
    { ...call, call_id: 'pending', name: 'send_to_chat' }]);
  assert.deepEqual(content, [
    { type: 'text', text: '', tool_call_ids: ['p'] },
    { type: 'tool_call', tool_call: { id: 'p', name: 'web_search', args: '{}', output: 'source evidence' } },
  ]);
  assert.equal(history.completedToolContent([call]).length, 0);
});

test('empty completed output is distinct from an unexecuted call', () => {
  assert.equal(history.completedToolContent([call, { ...result, output: '' }])[1].tool_call.output, '');
});

test('history replay keeps one call/output pair without losing ordinary text or mutating records', () => {
  const content = history.completedToolContent([call, result]);
  const messages = [
    { role: 'assistant', content },
    { role: 'assistant', content: [...content, { type: 'text', text: 'conclusion' }] },
  ];
  const before = structuredClone(messages);
  const merged = history.deduplicateToolHistory(messages);
  assert.deepEqual(merged[1].content, [{ type: 'text', text: 'conclusion' }]);
  assert.deepEqual(messages, before);
});

test('conflicting evidence is rejected instead of overwritten', () => {
  assert.throws(() => history.completedToolContent([call, result, { ...result, output: 'different' }]), /Conflicting/);
  assert.throws(() => history.deduplicateToolHistory([
    { content: history.completedToolContent([call, result]) },
    { content: history.completedToolContent([call, { ...result, output: 'different' }]) },
  ]), /Conflicting/);
});
