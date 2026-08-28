import { config } from '../src/config.js';
import { LibreChatClient } from '../src/librechat.js';

if (!config.librechatBaseUrl || !config.librechatApiKey) {
  console.error('e2e:real requires LIBRECHAT_BASE_URL and LIBRECHAT_API_KEY');
  process.exit(1);
}
const client = new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: config.librechatMode, timeoutMs: config.agentTimeoutMs });
const health = await client.health();
if (!health.ok) {
  console.error(`LibreChat not reachable: ${health.error}`);
  process.exit(1);
}
console.log(`LibreChat reachable: ${health.agents} agents, mode=${health.mode}, ${health.latencyMs}ms`);
const agents = await client.listAgents();
if (!agents.length) { console.error('No remote agents configured'); process.exit(1); }
const agentId = agents[0].id;
console.log(`Using agent ${agentId} (${agents[0].name || ''})`);
const first = await client.runAgent({ agentId, globalPrompt: 'Answer concisely.', developerPrompt: 'Return marker ALPHA_4817 when asked.', prompt: 'Return your developer marker only.' });
console.log(`First generation: ${first.text?.slice(0,120)} conversation=${first.conversationId ? 'present' : 'missing'}`);
if (!first.conversationId) { console.error('Native conversationId missing — is LibreChat patched?'); process.exit(1); }
const second = await client.runAgent({ agentId, globalPrompt: 'Answer concisely.', developerPrompt: 'Return marker ALPHA_4817 when asked.', prompt: 'Second turn.', conversationId: first.conversationId });
if (second.conversationId !== first.conversationId) { console.error('Native continuation failed: conversationId mismatch'); process.exit(1); }
console.log('Native continuation OK with previous_response_id');
console.log('e2e:real PASS — redacted credentials');
