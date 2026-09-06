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

// Create new Navier-Stokes workspace
const sessionRaw = await mcp.callTool({
  name: 'multicontext_orchestrate_create_session',
  arguments: { preset: 'navier-stokes-4', name: 'Navier-Stokes Fix Test v2' }
});
const session = parseToolResult(sessionRaw);
const wsId = session?.workspace?.id;
console.log('wsId:', wsId);

const wsRaw = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
const ws = parseToolResult(wsRaw);
console.log('defaultAgentId:', ws?.defaultAgentId);
console.log('Members:', Object.values(ws?.members || {}).map(m => `${m.name}(${m.agentId||'no-agent'})`).join(', '));

if (wsId) {
  // Start run
  const startedRaw = await mcp.callTool({
    name: 'multicontext_orchestrate_start_run',
    arguments: { workspace_id: wsId, prompt: 'Analyze Navier-Stokes regularity', broadcast: true, priority: 0, timeout_seconds: 60 }
  });
  const started = parseToolResult(startedRaw);
  console.log('RUN started:', started?.run_id);

  // Wait 10 seconds for model to process
  await new Promise(r => setTimeout(r, 10000));
  
  const wsRaw2 = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
  const ws2 = parseToolResult(wsRaw2);
  console.log('\nMESSAGES:');
  for (const [id, m] of Object.entries(ws2?.members || {})) {
    console.log(`  ${m.name}: status=${m.status}, msgs=${m.messages?.length||0}, queue=${m.queue?.length||0}`);
    if (m.messages && m.messages.length > 0) {
      for (const msg of m.messages.slice(-2)) {
        console.log(`    ${msg.role}: ${msg.content?.slice(0, 80) || 'none'}`);
      }
    }
  }

  const events = ws2?.orchestratorEvents || [];
  console.log('\nEVENTS (last 8):');
  for (const e of events.slice(-8)) {
    console.log(`  ${e.type} (${e.origin}): ${JSON.stringify(e.detail||'').slice(0, 80)}`);
  }
}

await mcp.close();
await transport.close();
