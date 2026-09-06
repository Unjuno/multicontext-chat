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

// Step 1: Create Navier-Stokes workspace
const sessionRaw = await mcp.callTool({
  name: 'multicontext_orchestrate_create_session',
  arguments: { preset: 'navier-stokes-4', name: 'Navier-Stokes Stress Test' }
});
const session = parseToolResult(sessionRaw);
const wsId = session?.workspace?.id;
console.log('wsId:', wsId);
if (!wsId) { console.log('Session:', JSON.stringify(session).slice(0, 500)); }

// Get member IDs
const members = session?.workspace?.members || [];
const memberIds = Object.values(members).map(m => m.id);
console.log('Members:', Object.values(members).map(m => m.name).join(', '));

if (wsId && memberIds.length > 0) {
  // Step 2: Start a run
  const startedRaw = await mcp.callTool({
    name: 'multicontext_orchestrate_start_run',
    arguments: { workspace_id: wsId, prompt: 'Analyze Navier-Stokes regularity', broadcast: true, priority: 0, timeout_seconds: 120 }
  });
  const started = parseToolResult(startedRaw);
  console.log('RUN started:', JSON.stringify(started).slice(0, 200));

  // Step 3: Poll in short requests. A single wait_until_settled call can
  // exceed the MCP client's fixed 60s request timeout during real inference.
  let state = null;
  for (let i = 0; i < 18; i++) {
    const stateRaw = await mcp.callTool({
      name: 'multicontext_orchestrate_get_state',
      arguments: { workspace_id: wsId }
    });
    state = parseToolResult(stateRaw);
    console.log(`STATE ${i + 1}:`, JSON.stringify(state).slice(0, 600));
    const terminalEvent = state?.events?.slice(-1)[0]?.type;
    if (terminalEvent === 'run.settled' || terminalEvent === 'run.blocked') break;
    await new Promise(r => setTimeout(r, 10000));
  }

  // Step 4: Get workspace view
  const wsRaw = await mcp.callTool({
    name: 'multicontext_get_workspace',
    arguments: { workspace_id: wsId }
  });
  const ws = parseToolResult(wsRaw);
  const wsStr = JSON.stringify(ws);
  console.log('MEMBER COUNT:', Object.keys(ws?.members || {}).length);
  for (const [id, m] of Object.entries(ws?.members || {})) {
    console.log(`  ${m.name}: status=${m.status}, queue=${m.queue?.length||0}, msgs=${m.messages?.length||0}, current=${m.current?'yes':'no'}`);
    if (m.messages && m.messages.length > 0) {
      const last = m.messages[m.messages.length-1];
      console.log(`    last msg: ${last.role}: ${last.content?.slice(0, 80) || 'none'}`);
    }
  }
  
  // Check orchestrator runs
  console.log('RUNS:', JSON.stringify(ws?.orchestratorRuns || {}).slice(0, 300));
  
  // Check for cross-chat events
  const events = ws?.orchestratorEvents || [];
  console.log('EVENTS:', events.length);
  for (const e of events.slice(-5)) {
    console.log(`  ${e.type} (${e.origin}): ${JSON.stringify(e.detail || '').slice(0, 100)}`);
  }
}

await mcp.close();
await transport.close();
