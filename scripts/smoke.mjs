import { config } from '../src/config.js';
import { LibreChatClient } from '../src/librechat.js';

const client = new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: config.librechatMode, timeoutMs: config.agentTimeoutMs });
const health = await client.health();
if (!health.ok) { console.error(`LibreChat smoke failed: ${health.error}`); process.exit(1); }
console.log(`LibreChat reachable: ${health.agents} remote agent(s), mode=${health.mode}, ${health.latencyMs}ms`);

const agentId = process.env.MULTICONTEXT_SMOKE_AGENT_ID;
if (!agentId) { console.log('Set MULTICONTEXT_SMOKE_AGENT_ID to run a real generation smoke test.'); process.exit(0); }
const first = await client.runAgent({ agentId, globalPrompt: 'Answer concisely.', developerPrompt: 'Return a short acknowledgement.', prompt: 'Smoke test.' });
if (!first.text) { console.error('Generation returned no visible text'); process.exit(1); }
console.log(`Generation OK: ${first.id || '(no response id)'}${first.conversationId ? `, conversation=${first.conversationId}` : ''}`);
if (config.librechatMode === 'native') {
  const second = await client.runAgent({ agentId, globalPrompt: 'Answer concisely.', developerPrompt: 'Return a short acknowledgement.', prompt: 'Second smoke turn.', conversationId: first.conversationId });
  if (!second.text || second.conversationId !== first.conversationId) { console.error('Native conversation continuation failed'); process.exit(1); }
  console.log('Native conversation continuation OK');
}
