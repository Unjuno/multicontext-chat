#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = process.argv[2] || path.join(root, 'src-tauri/target/release/bundle/macos/MultiContext.app');
const resourceRoot = path.join(app, 'Contents/Resources/multicontext/public');

if (!fs.existsSync(resourceRoot)) {
  console.error(`desktop bundle resources not found: ${resourceRoot}`);
  process.exit(1);
}

const markers = [
  ['index.html', 'id="desktopSettings"'],
  ['index.html', 'ショートカットと使い方'],
  ['app.js', 'compileHistory'],
  ['desktop-startup.html', 'データ保存場所を開く'],
];

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const [file, marker] of markers) {
  const target = path.join(resourceRoot, file);
  const content = fs.readFileSync(target, 'utf8');
  if (!content.includes(marker)) {
    console.error(`desktop bundle marker missing: ${file} -> ${marker}`);
    process.exit(1);
  }
}

for (const file of ['index.html', 'app.js', 'desktop-startup.html', 'activity-feed.js']) {
  const source = path.join(root, 'public', file);
  const packaged = path.join(resourceRoot, file);
  if (digest(source) !== digest(packaged)) {
    console.error(`desktop bundle is stale: ${file}`);
    process.exit(1);
  }
}

const serverSource = path.join(root, 'dist/server.bundle.mjs');
const serverPackaged = path.join(app, 'Contents/Resources/multicontext/dist/server.bundle.mjs');
if (!fs.existsSync(serverPackaged) || digest(serverSource) !== digest(serverPackaged)) {
  console.error('desktop bundle server is missing or stale');
  process.exit(1);
}

console.log(`desktop bundle verified: ${app}`);
