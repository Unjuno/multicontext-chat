import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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

const wsId = '3a270121-6b9d-4784-a370-114e40ed02bb';

// Wait 40 more seconds
await new Promise(r => setTimeout(r, 40000));

const wsRaw = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
const ws = parseToolResult(wsRaw);

console.log('MEMBER STATUS:');
for (const [id, m] of Object.entries(ws?.members || {})) {
  console.log(`  ${m.name}: status=${m.status}, msgs=${m.messages?.length||0}`);
  if (m.messages && m.messages.length > 1) {
    for (const msg of m.messages.slice(-2)) {
      const content = (msg.content||'').slice(0, 120);
      console.log(`    [${msg.role}] ${content}`);
    }
  }
}

const events = ws?.orchestratorEvents || [];
console.log(`\nEVENTS (${events.length}):`);
for (const e of events.slice(-10)) {
  console.log(`  ${e.type} (${e.origin})${e.memberId ? ` member=${e.memberId}` : ''}: ${JSON.stringify(e.detail||'').slice(0, 100)}`);
}

const stateRaw = await mcp.callTool({ name: 'multicontext_orchestrate_get_state', arguments: { workspace_id: wsId } });
const state = parseToolResult(stateRaw);
console.log(`\nQUEUE LEN: ${state?.queue?.length}, PAUSED: ${state?.paused}`);

await mcp.close();
await transport.close();
