#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'dist/server.bundle.mjs');

if (!fs.existsSync(bundle)) {
  console.error('bundle not found:', bundle);
  process.exit(1);
}

// Use a random port to avoid collision
const port = 4321 + Math.floor(Math.random() * 1000);
const env = { ...process.env, MULTICONTEXT_PORT: String(port), MULTICONTEXT_HOST: '127.0.0.1', MULTICONTEXT_MCP_TOKEN: 'ci-verify-token', MULTICONTEXT_MCP_ENABLED: 'true', LIBRECHAT_BASE_URL: 'http://127.0.0.1:1', MULTICONTEXT_DATA_FILE: '/tmp/mc-verify-bundle.json' };
try { fs.unlinkSync(env.MULTICONTEXT_DATA_FILE); } catch {}

const child = spawn(process.execPath, [bundle], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok || res.status === 503) {
        // Check that server is listening (any response)
        return true;
      }
    } catch {}
  }
  return false;
}

const ok = await waitForHealth();
if (!ok) {
  console.error('bundle server did not become ready');
  console.error(out.slice(-2000));
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch {}
  process.exit(1);
}

console.log('bundle server ready, testing /mcp');

// Test MCP initialize via StreamableHTTPClientTransport
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${env.MULTICONTEXT_MCP_TOKEN}` } },
});
const mcp = new Client({ name: 'ci-verify', version: '1.0.0' });
try {
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  if (!tools.tools.some(t => t.name === 'multicontext_list_workspaces')) {
    throw new Error('list_workspaces tool not found');
  }
  const res = await mcp.callTool({ name: 'multicontext_list_workspaces', arguments: {} });
  if (res.isError) throw new Error('list_workspaces returned isError');
  console.log('MCP list_workspaces via bundle succeeded');
  await mcp.close();
} catch (e) {
  console.error('MCP verify failed:', e);
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch {}
  process.exit(1);
}

child.kill('SIGTERM');
await new Promise(r => setTimeout(r, 500));
try { child.kill('SIGKILL'); } catch {}
console.log('bundle verification passed');
