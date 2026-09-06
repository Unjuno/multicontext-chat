import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StateStore } from './src/store.js';
import fs from 'fs';

const base = 'http://127.0.0.1:4317';
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: 'Bearer parity-token' } },
});
const mcp = new Client({ name: 'stress-test', version: '1.0.0' });
await mcp.connect(transport);

function parseToolResult(result) {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// Check the actual run status by reading the store
const wsId = '04032e40-5187-4542-9f21-ecddff155af1';

// Use MCP to get workspace
const wsRaw = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
const ws = parseToolResult(wsRaw);

// Check member statuses and queue
console.log('MEMBERS:');
for (const [id, m] of Object.entries(ws?.members || {})) {
  console.log(`  ${m.name}: status=${m.status}, queue=${m.queue?.length||0}, msgs=${m.messages?.length||0}, current=${m.current?'yes':'no'}, lastError=${m.lastError||'none'}`);
}

// Get orchestrator state via MCP
const stateRaw = await mcp.callTool({ name: 'multicontext_orchestrate_get_state', arguments: { workspace_id: wsId } });
const state = parseToolResult(stateRaw);
console.log('\nSTATE:', JSON.stringify(state).slice(0, 1000));

// Check events
if (state?.events) {
  console.log('\nEVENTS (last 10):');
  for (const e of state.events.slice(-10)) {
    console.log(`  ${e.type} (${e.origin}): ${JSON.stringify(e.detail||'').slice(0, 100)}`);
  }
}

// Check if runs exist by calling get_state again
const runsRaw = await mcp.callTool({ name: 'multicontext_orchestrate_get_run', arguments: { workspace_id: wsId, run_id: 'd960796f-6c54-43bb-a4fa-832ed8b3b777' } });
const run = parseToolResult(runsRaw);
console.log('\nRUN:', JSON.stringify(run).slice(0, 500));

await mcp.close();
await transport.close();
