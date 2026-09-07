import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyResourceTree } from '../scripts/verify-resource-tree.mjs';

test('desktop resources verify every file, including new modules, styles and nested assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-resource-test-'));
  try {
    const source = path.join(dir, 'source'), packaged = path.join(dir, 'packaged');
    for (const root of [source, packaged]) {
      fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
      for (const file of ['review-notes.js', 'styles.css', 'nested/asset.txt']) fs.writeFileSync(path.join(root, file), 'current');
    }
    assert.equal(verifyResourceTree(source, packaged), 3);
    for (const file of ['review-notes.js', 'styles.css', 'nested/asset.txt']) {
      fs.writeFileSync(path.join(packaged, file), 'stale');
      assert.throws(() => verifyResourceTree(source, packaged), /stale/);
      fs.writeFileSync(path.join(packaged, file), 'current');
    }
    fs.renameSync(path.join(packaged, 'review-notes.js'), path.join(packaged, 'old.js'));
    assert.throws(() => verifyResourceTree(source, packaged), /missing/);
    fs.writeFileSync(path.join(packaged, 'review-notes.js'), 'current');
    assert.throws(() => verifyResourceTree(source, packaged), /unexpected/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
