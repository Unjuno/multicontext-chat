import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/calculation.js';
import { CrossChatToolExecutor } from '../src/cross-chat-executor.js';

test('calculation evaluates arithmetic with documented precedence', () => {
  for (const [expression, expected] of [['17*19', 323], ['(1/2-1/4)/(1/2-1/6)', .75], ['2^3^2', 512], ['-2^2', -4], ['(-2)^2', 4], ['2^-2', .25], ['1e-3 + .009', .01], ['1/(1-3/4)', 4]]) {
    assert.ok(Math.abs(calculate({ expression }).value - expected) < 1e-12, expression);
  }
});
test('calculation refuses code, identifiers, nonfinite values and malformed input', () => {
  for (const expression of ['process.exit()', '1;2', 'Infinity', '1e309', '1/0', '(-1)^.5', '2**3', '2(3)', '(1', '1)', '', 'x', '1+'.repeat(200)]) {
    assert.throws(() => calculate({ expression }), { code: 'INVALID_EXPRESSION' });
  }
  assert.throws(() => calculate({ expression: '2', extra: true }));
});
test('calculator integrates as external tool without application mutations', async () => {
  const results = await new CrossChatToolExecutor({ app: {} }).execute({ toolCalls: [{ call_id: 'calc', name: 'calculate', arguments: '{"expression":"17*19"}' }] });
  assert.equal(results[0].call_id, 'calc');
  assert.equal(JSON.parse(results[0].output).value, 323);
  const invalid = await new CrossChatToolExecutor({ app: {} }).execute({ toolCalls: [{ call_id: 'invalid', name: 'calculate', arguments: '{"expression":"1/0"}' }] });
  assert.equal(JSON.parse(invalid[0].output).error.code, 'INVALID_EXPRESSION');
});
