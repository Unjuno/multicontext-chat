import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return files(root, relative);
    if (!entry.isFile()) throw new Error(`Unsupported resource entry: ${relative}`);
    return [relative];
  }).sort();
}

export function verifyResourceTree(source, packaged) {
  const expected = files(source);
  const actual = files(packaged);
  for (const file of expected) {
    if (!actual.includes(file)) throw new Error(`desktop bundle resource missing: ${file}`);
    const digest = root => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (digest(source) !== digest(packaged)) throw new Error(`desktop bundle is stale: ${file}`);
  }
  for (const file of actual) {
    if (!expected.includes(file)) throw new Error(`desktop bundle has unexpected resource: ${file}`);
  }
  return expected.length;
}
