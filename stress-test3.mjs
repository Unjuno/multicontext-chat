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
  arguments: { preset: 'navier-stokes-4', name: 'Navier-Stokes Fix Test' }
});
const session = parseToolResult(sessionRaw);
const wsId = session?.workspace?.id;
console.log('wsId:', wsId);
console.log('Members:', Object.values(session?.workspace?.members || {}).map(m => `${m.name}(${m.agentId||'no-agent'}`).join(', '));

// Verify defaultAgentId was set
const wsRaw = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
const ws = parseToolResult(wsRaw);
console.log('defaultAgentId:', ws?.defaultAgentId);

if (wsId) {
  // Start run
  const startedRaw = await mcp.callTool({
    name: 'multicontext_orchestrate_start_run',
    arguments: { workspace_id: wsId, prompt: 'Analyze Navier-Stokes regularity', broadcast: true, priority: 0, timeout_seconds: 60 }
  });
  const started = parseToolResult(startedRaw);
  console.log('RUN:', JSON.stringify(started).slice(0, 200));

  // Wait 8 seconds for model to process
  await new Promise(r => setTimeout(r, 8000));
  
  const stateRaw = await mcp.callTool({ name: 'multicontext_orchestrate_get_state', arguments: { workspace_id: wsId } });
  const state = parseToolResult(stateRaw);
  console.log('\nSTATE:', JSON.stringify(state).slice(0, 400));

  // Check messages
  const wsRaw2 = await mcp.callTool({ name: 'multicontext_get_workspace', arguments: { workspace_id: wsId } });
  const ws2 = parseToolResult(wsRaw2);
  console.log('\nMESSAGES:');
  for (const [id, m] of Object.entries(ws2?.members || {})) {
    console.log(`  ${m.name}: status=${m.status}, msgs=${m.messages?.length||0}`);
    if (m.messages && m.messages.length > 0) {
      console.log(`    last: ${m.messages[m.messages.length-1].role}: ${m.messages[m.messages.length-1].content?.slice(0, 60) || 'none'}`);
    }
  }

  // Check events
  const events = ws2?.orchestratorEvents || [];
  console.log('\nEVENTS (last 5):');
  for (const e of events.slice(-5)) {
    console.log(`  ${e.type} (${e.origin}): ${JSON.stringify(e.detail||'').slice(0, 80)}`);
  }
}

await mcp.close();
await transport.close();
