import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureDetails } from '../scripts/signature-details.mjs';

test('successful codesign inspection reads stderr and failed inspections fail closed', () => {
  assert.match(signatureDetails({ status: 0, stdout: '', stderr: 'Authority=Developer ID Application: Example\nTeamIdentifier=EXAMPLE' }), /Authority=Developer ID Application/);
  assert.match(signatureDetails({ status: 0, stderr: 'Signature=adhoc' }), /Signature=adhoc/);
  assert.throws(() => signatureDetails({ status: 1, stderr: 'Authority=Developer ID Application' }), /could not inspect/);
  assert.throws(() => signatureDetails({ status: null, error: new Error('ENOENT') }), /could not inspect/);
});
