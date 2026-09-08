import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readConfig = extraEnv => {
  const env = { PATH: process.env.PATH, ...extraEnv };
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { config } from './src/config.js'; console.log(JSON.stringify({backend:config.backend,dataFile:config.dataFile,localModelUrl:config.localModelUrl}))"],
  { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('registration-free local backend and isolated local state are Node defaults', () => {
  const value = readConfig({});
  assert.equal(value.backend, 'local');
  assert.equal(value.localModelUrl, 'http://127.0.0.1:8080');
  assert.equal(value.dataFile, path.join(root, 'data/local-state.json'));
});

test('LibreChat remains an explicit compatibility backend with separate state', () => {
  const value = readConfig({ MULTICONTEXT_BACKEND: 'librechat' });
  assert.equal(value.backend, 'librechat');
  assert.equal(value.dataFile, path.join(root, 'data/state.json'));
});
