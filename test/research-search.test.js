import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchSearch, parseWebResults } from '../src/research-search.js';
import { CrossChatToolExecutor, isCrossChatToolCall } from '../src/cross-chat-executor.js';
import { LibreChatClient } from '../src/librechat.js';

test('native tool continuation rebinds persona instructions without replaying user history', async () => {
  let body;
  const client = new LibreChatClient({ baseUrl: 'http://localhost', apiKey: 'test', mode: 'native', fetchImpl: async (_, options) => {
    body = JSON.parse(options.body);
    return Response.json({ id: 'r', output: [] }, { headers: { 'X-LibreChat-Conversation-Id': 'conv' } });
  } });
  await client.continueAgent({ agentId: 'a', conversationId: 'conv', globalPrompt: 'global', developerPrompt: 'persona', orderedItems: [] });
  assert.deepEqual(body.input, [{ role: 'system', content: 'global' }, { role: 'developer', content: 'persona' }]);
  assert.equal(body.previous_response_id, 'conv');
});

test('native client advertises standard search and supports opting out', () => {
  const args = { baseUrl: 'http://localhost:3080', apiKey: 'test', mode: 'native' };
  assert.ok(new LibreChatClient(args).tools.some(tool => tool.function.name === 'search_sources'));
  assert.ok(new LibreChatClient({ ...args, searchEnabled: false }).tools.every(tool => tool.function.name !== 'search_sources'));
});

const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper">A &amp; B</a><a class="result__snippet">Real <b>snippet</b></a>';
test('web parsing decodes citation links and rejects challenges instead of inventing results', () => {
  assert.deepEqual(parseWebResults(html, 5), [{ title: 'A & B', url: 'https://example.org/paper', snippet: 'Real snippet' }]);
  assert.throws(() => parseWebResults('<form action="anomaly.js">challenge</form>', 5), { code: 'SEARCH_BLOCKED' });
  assert.throws(() => parseWebResults('<html>unexpected</html>', 5), { code: 'SEARCH_FORMAT_CHANGED' });
  assert.deepEqual(parseWebResults('No results found', 5), []);
});

test('requests are fixed-host, bounded, cached, and cancellable', async () => {
  let calls = 0;
  const search = new ResearchSearch({ intervalMs: 0, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://html.duckduckgo.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Response(html);
  } });
  const first = await search.search({ query: 'Navier Stokes' });
  const second = await search.search({ query: 'Navier Stokes' });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  await assert.rejects(search.search({ query: 'x', limit: 0 }), { code: 'INVALID_TOOL_ARGUMENTS' });
  await assert.rejects(search.search({ query: 'x', endpoint: 'http://localhost' }), { code: 'INVALID_TOOL_ARGUMENTS' });
  await assert.rejects(search.search({ query: 'x' }, { signal: AbortSignal.abort() }));
  assert.equal(calls, 1);
});

test('scholarly metadata has provenance and does not claim full-text access', async () => {
  const search = new ResearchSearch({ intervalMs: 0, fetchImpl: async url => {
    assert.equal(url.origin, 'https://api.crossref.org');
    return Response.json({ message: { items: [{ DOI: '10.1234/example', title: ['Regularity'], published: { 'date-parts': [[2020]] } }] } });
  } });
  const result = await search.search({ query: 'regularity', source: 'papers' });
  assert.equal(result.evidenceType, 'scholarly_metadata');
  assert.equal(result.results[0].url, 'https://doi.org/10.1234/example');
  assert.ok(result.retrievedAt);
});

test('search outages, oversize responses and disabled mode are explicit', async () => {
  for (const [response, code] of [[new Response('', { status: 429 }), 'SEARCH_RATE_LIMITED'], [new Response('x'.repeat(1_000_001)), 'SEARCH_RESPONSE_TOO_LARGE']]) {
    const search = new ResearchSearch({ intervalMs: 0, fetchImpl: async () => response });
    await assert.rejects(search.search({ query: 'x' }), { code });
  }
  await assert.rejects(new ResearchSearch({ enabled: false }).search({ query: 'x' }), { code: 'SEARCH_DISABLED' });
});

test('native external executor returns actual search output under the model call ID', async () => {
  assert.ok(isCrossChatToolCall({ name: 'search_sources' }));
  const executor = new CrossChatToolExecutor({ app: {}, search: { search: async args => ({ ok: true, query: args.query, results: [{ url: 'https://example.org' }] }) } });
  const result = await executor.execute({ toolCalls: [{ name: 'search_sources', call_id: 'search-call', arguments: '{"query":"proof"}' }] });
  assert.equal(result[0].call_id, 'search-call');
  assert.equal(JSON.parse(result[0].output).results[0].url, 'https://example.org');
});
