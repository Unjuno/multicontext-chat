import test from 'node:test';
import assert from 'node:assert/strict';
import mixed from '../scripts/librechat-mixed-handler.cjs';
import { verifyInstalledMixedSource } from '../scripts/verify-librechat-installed-source.mjs';

test('installed mixed verifier refuses stale or missing helper code before contract execution', () => {
  const handler = mixed.createMixedOwnershipHandler.toString();
  const serializer = mixed.createMixedResultSerializer.toString();
  assert.doesNotThrow(() => verifyInstalledMixedSource(`${handler}\n${serializer}`));
  assert.throws(() => verifyInstalledMixedSource(serializer), /createMixedOwnershipHandler.*missing or stale/);
  assert.throws(() => verifyInstalledMixedSource(handler), /createMixedResultSerializer.*missing or stale/);
  assert.throws(() => verifyInstalledMixedSource(`${handler.replace('callIds.has(call.id)', 'false')}\n${serializer}`),
    /createMixedOwnershipHandler.*missing or stale/);
});
