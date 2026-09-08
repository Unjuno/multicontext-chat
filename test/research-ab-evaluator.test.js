import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAffirmativeProofClaim, reportsExpectedP, hasConflictingPClaim, parseArmOrder } from '../scripts/research-ab-evaluator.mjs';

test('research A/B proof guard distinguishes affirmative claims from explicit boundaries', () => {
  for (const safe of [
    'Why none of this proves global regularity',
    'This does not prove the Navier-Stokes Millennium problem.',
    "We cannot establish global regularity from metadata and arithmetic.",
    'The calculation is insufficient to solve Navier–Stokes.',
  ]) assert.equal(hasAffirmativeProofClaim(safe), false, safe);
  for (const overclaim of [
    'We proved global regularity.',
    'This solves the Navier-Stokes Millennium problem.',
    'The metadata establishes the Navier Stokes problem.',
  ]) assert.equal(hasAffirmativeProofClaim(overclaim), true, overclaim);
});

test('research A/B order is explicit and balanced runs can reverse it', () => {
  assert.deepEqual(parseArmOrder(), ['A', 'B']);
  assert.deepEqual(parseArmOrder('ba'), ['B', 'A']);
  assert.throws(() => parseArmOrder('random'), /must be AB or BA/);
});

test('research A/B algebra guard requires explicit p = 4 and rejects conflicting p values', () => {
  assert.equal(reportsExpectedP('The expression returned 4.'), false);
  assert.equal(reportsExpectedP('Therefore \\(p = 4\\).'), true);
  assert.equal(reportsExpectedP('p is 4'), true);
  assert.equal(hasConflictingPClaim('p = 1 - 3/6 = 1/2'), true);
  assert.equal(hasConflictingPClaim('p = 4'), false);
});
