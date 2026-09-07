#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const app = path.join(root, 'src-tauri/target/release/bundle/macos/MultiContext.app');
if (process.platform !== 'darwin') {
  console.error('signing verification requires macOS');
  process.exit(2);
}
if (!fs.existsSync(app)) {
  console.error(`signed app not found: ${app}`);
  process.exit(2);
}
let details = '';
try {
  details = execFileSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  details = `${error.stdout || ''}${error.stderr || ''}`;
}
if (/Signature=adhoc|TeamIdentifier=not set/.test(details)) {
  console.error('release signing failed: app is adhoc-signed or has no TeamIdentifier');
  process.exit(1);
}
if (!/Authority=Developer ID Application/.test(details)) {
  console.error('release signing failed: Developer ID Application authority not found');
  process.exit(1);
}
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
console.log(`release signing verified: ${app}`);
