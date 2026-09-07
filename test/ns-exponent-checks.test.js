import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExponentReport } from '../scripts/ns-exponent-checks.mjs';

test('NS arithmetic gate rejects observed incorrect scaling and missing fields', () => {
  assert.equal(checkExponentReport('scaling', '{"kinetic":0,"enstrophy":2}').passed, false);
  assert.equal(checkExponentReport('scaling', 'plausible explanation').passed, false);
  assert.equal(checkExponentReport('scaling', 'null').passed, false);
});
test('NS arithmetic gate accepts correct exponents without certifying a proof', () => {
  const result = checkExponentReport('scaling', '{"kinetic":-1,"enstrophy":1,"palinstrophy":3,"stretching":3}');
  assert.equal(result.passed, true);
  assert.equal(result.scope, 'NUMERIC_EXPONENTS_ONLY');
});
test('NS interpolation gate checks every exponent, rejecting strings and old error', () => {
  const values = { theta: .75, enstrophyPower: .75, palinstrophyPower: .75, youngP: 4/3, youngQ: 4, viscosityPower: -3, finalEnstrophyPower: 3 };
  assert.equal(checkExponentReport('interpolation', JSON.stringify(values)).passed, true);
  for (const [key, value] of Object.entries(values)) {
    assert.equal(checkExponentReport('interpolation', JSON.stringify({ ...values, [key]: String(value) })).passed, false);
  }
  assert.equal(checkExponentReport('interpolation', JSON.stringify({ ...values, theta: .25 })).passed, false);
});
