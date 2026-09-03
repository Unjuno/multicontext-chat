import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORT,
  ensureReady,
  forwardOneLine,
  healthUrl,
  isAppRunning,
  isReady,
  mapHttpResponseToStdio,
  mcpUrl,
  openAppInBackground,
  requestIdOf,
  resolveAppPath,
  waitForReady,
} from '../scripts/multicontext-mcp-launcher.mjs';

test('launcher URL helpers use loopback default port', () => {
  assert.equal(mcpUrl(), 'http://127.0.0.1:4317/mcp');
  assert.equal(healthUrl(), 'http://127.0.0.1:4317/api/health');
  assert.equal(mcpUrl(9999), 'http://127.0.0.1:9999/mcp');
  assert.equal(DEFAULT_PORT, 4317);
});

test('resolveAppPath prefers explicit env, then /Applications, then home', () => {
  const exists = (p) => p === '/env/MultiContext.app' || p === '/Applications/MultiContext.app';
  assert.equal(
    resolveAppPath({ env: { MULTICONTEXT_APP_PATH: '/env/MultiContext.app' }, existsSync: exists, home: '/h' }),
    '/env/MultiContext.app',
  );
  assert.equal(
    resolveAppPath({ env: {}, existsSync: exists, home: '/h' }),
    '/Applications/MultiContext.app',
  );
  assert.equal(
    resolveAppPath({ env: {}, existsSync: (p) => p === '/h/Applications/MultiContext.app', home: '/h' }),
    '/h/Applications/MultiContext.app',
  );
  assert.equal(resolveAppPath({ env: {}, existsSync: () => false, home: '/h' }), null);
});

test('isAppRunning reflects pgrep outcome', () => {
  assert.equal(isAppRunning({ runner: () => ({ status: 0, stdout: '1234\n' }) }), true);
  assert.equal(isAppRunning({ runner: () => ({ status: 1, stdout: '' }) }), false);
  assert.equal(isAppRunning({ runner: () => { throw new Error('no pgrep'); } }), false);
});

test('isReady requires ok:true and survives failures', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const unhealthy = async () => ({ ok: true, json: async () => ({ ok: false }) });
  const http500 = async () => ({ ok: false });
  const throwing = async () => { throw new Error('down'); };
  assert.equal(await isReady({ fetchImpl: okFetch }), true);
  assert.equal(await isReady({ fetchImpl: unhealthy }), false);
  assert.equal(await isReady({ fetchImpl: http500 }), false);
  assert.equal(await isReady({ fetchImpl: throwing }), false);
});

test('waitForReady polls then succeeds; times out with a clear error', async () => {
  let calls = 0;
  const flaky = async () => ({ ok: true, json: async () => ({ ok: ++calls >= 3 }) });
  let now = 0;
  const ok = await waitForReady({
    fetchImpl: flaky, sleepImpl: async () => {}, now: () => now,
    timeoutMs: 10000, pollMs: 1000,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
  const never = async () => { throw new Error('down'); };
  await assert.rejects(
    waitForReady({ fetchImpl: never, sleepImpl: async () => { now += 1000; }, now: () => now, timeoutMs: 2500, pollMs: 1000 }),
    /did not become ready within 2500ms/,
  );
});

test('ensureReady reuses a healthy endpoint without launching', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  let opened = 0;
  const out = await ensureReady({
    fetchImpl: okFetch,
    deps: { fetchImpl: okFetch, runner: () => { opened += 1; return { status: 0 }; } },
  });
  assert.deepEqual(out, { launched: false });
  assert.equal(opened, 0);
});

test('ensureReady honors NO_LAUNCH and missing app path', async () => {
  const down = async () => { throw new Error('down'); };
  await assert.rejects(
    ensureReady({ fetchImpl: down, noLaunch: true, deps: { fetchImpl: down } }),
    /MULTICONTEXT_NO_LAUNCH=1/,
  );
  await assert.rejects(
    ensureReady({ fetchImpl: down, deps: { fetchImpl: down, env: {}, existsSync: () => false, home: '/h' } }),
    /no MultiContext.app was found/,
  );
});

test('ensureReady opens the app once when down and waits for health', async () => {
  let opened = [];
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/health')) {
      polls += 1;
      if (polls < 3) throw new Error('down');
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const out = await ensureReady({
    fetchImpl,
    deps: {
      fetchImpl,
      env: {},
      existsSync: (p) => p === '/Applications/MultiContext.app',
      home: '/h',
      runner: (args) => { opened.push(args); return { status: 0, stdout: '' }; },
      sleepImpl: async () => {},
      now: () => 0,
    },
  });
  assert.deepEqual(out, { launched: true });
  assert.deepEqual(opened, [['pgrep', '-f', 'multicontext-desktop'], ['open', '-g', '-a', '/Applications/MultiContext.app']]);
});

test('openAppInBackground uses background open and surfaces failures', () => {
  openAppInBackground('/A.app', { runner: () => ({ status: 0 }) });
  assert.throws(
    () => openAppInBackground('/A.app', { runner: () => ({ status: 1, stderr: 'nope' }) }),
    /Failed to open \/A\.app: nope/,
  );
});

test('mapHttpResponseToStdio fans out SSE data lines and captures nothing else', () => {
  const out = mapHttpResponseToStdio({
    status: 200, headers: {}, requestId: 'r1',
    bodyText: 'event: message\ndata: {"jsonrpc":"2.0","id":"r1","result":{}}\n\nevent: message\ndata: [DONE]\n',
  });
  assert.deepEqual(out, { sessionId: null, outLines: ['{"jsonrpc":"2.0","id":"r1","result":{}}'] });
});

test('mapHttpResponseToStdio passes JSON-RPC through and wraps foreign bodies', () => {
  const rpc = mapHttpResponseToStdio({ status: 200, headers: {}, requestId: 'r2', bodyText: '{"jsonrpc":"2.0","id":"r2","result":{"ok":true}}' });
  assert.deepEqual(rpc.outLines, ['{"jsonrpc":"2.0","id":"r2","result":{"ok":true}}']);
  const wrapped = mapHttpResponseToStdio({ status: 404, headers: {}, requestId: 'r3', bodyText: '{"error":"MCP disabled"}' });
  const parsed = JSON.parse(wrapped.outLines[0]);
  assert.equal(parsed.jsonrpc, '2.0');
  assert.equal(parsed.id, 'r3');
  assert.equal(parsed.error.code, -32000);
  assert.match(parsed.error.message, /404/);
  const empty = mapHttpResponseToStdio({ status: 202, headers: {}, requestId: null, bodyText: '' });
  assert.deepEqual(empty.outLines, []);
});

test('requestIdOf extracts ids only from single messages', () => {
  assert.equal(requestIdOf('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'), 7);
  assert.equal(requestIdOf('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
  assert.equal(requestIdOf('not json'), null);
  assert.equal(requestIdOf('[{"jsonrpc":"2.0","id":1}]'), null);
});

test('forwardOneLine sends session header after capturing it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.headers);
    const first = calls.length === 1;
    return {
      status: 200,
      headers: new Map(first ? [['mcp-session-id', 'sess-1']] : []),
      text: async () => (first
        ? '{"jsonrpc":"2.0","id":"i1","result":{"protocolVersion":"x"}}'
        : '{"jsonrpc":"2.0","id":"i2","result":{}}'),
    };
  };
  const line1 = '{"jsonrpc":"2.0","id":"i1","method":"initialize","params":{}}';
  const r1 = await forwardOneLine({ line: line1, endpoint: 'http://x/mcp', token: 'tok', sessionId: null, fetchImpl });
  assert.equal(calls[0].Authorization, 'Bearer tok');
  assert.equal(r1.sessionId, 'sess-1');
  const line2 = '{"jsonrpc":"2.0","id":"i2","method":"tools/list","params":{}}';
  await forwardOneLine({ line: line2, endpoint: 'http://x/mcp', token: null, sessionId: r1.sessionId, fetchImpl });
  assert.equal(calls[1]['Mcp-Session-Id'], 'sess-1');
  assert.ok(!('Authorization' in calls[1]));
});
