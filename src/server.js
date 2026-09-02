import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.js';
import { StateStore, searchMemberMessages, publicMember } from './store.js';
import { LibreChatClient } from './librechat.js';
import { Scheduler } from './scheduler.js';
import { buildActionSpec } from './openapi.js';
import { createApplication } from './application.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.resolve(__dirname, '../public');
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(status === 204 ? '' : JSON.stringify(body)); };
const readBody = async (req) => {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) throw Object.assign(new Error('Request body too large'), { status: 413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};

export function createApp({ config = defaultConfig, store, client, scheduler, publicDir = defaultPublicDir } = {}) {
  store ??= new StateStore(config.dataFile);
  client ??= new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, mode: config.librechatMode, timeoutMs: config.agentTimeoutMs });
  scheduler ??= new Scheduler({ store, client, maxHistoryMessages: config.maxHistoryMessages });

  const app = createApplication({ config, store, client, scheduler });
  scheduler.setApp?.(app);
  const authorized = (req) => !config.appToken || req.headers.authorization === `Bearer ${config.appToken}`;
  const toolAuthorized = (req) => !config.toolSecret || req.headers['x-multicontext-key'] === config.toolSecret;
  const mcpAuthorized = (req) => {
    if (!config.mcpEnabled) return false;
    if (!config.mcpToken) return true; // if no token configured, allow (dev mode) but still check enabled
    const auth = req.headers.authorization || '';
    // Support Bearer token
    if (auth === `Bearer ${config.mcpToken}`) return true;
    // Also support X-MCP-Token header
    if (req.headers['x-mcp-token'] === config.mcpToken) return true;
    return false;
  };
  const requestOrigin = (req) => {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    if (proto !== 'http' && proto !== 'https') return null;
    const host = req.headers.host;
    if (!host) return null;
    return `${proto}://${host}`;
  };
  const publicOrigin = (req) => config.publicUrl || requestOrigin(req) || `http://${config.host}:${config.port}`;

  const enrichView = (view, req) => {
    const origin = publicOrigin(req);
    for (const [mid, m] of Object.entries(view.members || {})) {
      if (!m.actionSpecUrl) m.actionSpecUrl = `${origin}/tools/${view.id}/${mid}/openapi.json`;
    }
    return view;
  };
  const getEnrichedWorkspace = async (id, req) => enrichView(await app.getWorkspace(id), req);
  const workspaceView = (id, req) => {
    const workspace = store.requireWorkspace(id); const runtimeState = store.runtimeState(id, scheduler.runningMemberIds(id));
    return { ...store.publicWorkspace(workspace, true), runtimeState, settled: runtimeState === 'SETTLED', runningMemberIds: [...scheduler.runningMemberIds(id)],
      members: Object.fromEntries(Object.entries(workspace.members).map(([mid, m]) => [mid, { ...publicMember(m), actionSpecUrl: `${publicOrigin(req)}/tools/${id}/${mid}/openapi.json` }])) };
  };

  // MCP handler lazy import to avoid circular deps during tests
  let mcpHandler = null;
  let mcpFetch = null;
  async function getMcpHandler() {
    if (mcpHandler) return mcpHandler;
    try {
      const mod = await import('./mcp/handler.js');
      const handler = mod.createMcpHandler({ config, store, client, scheduler, app });
      mcpHandler = handler;
      mcpFetch = handler.fetch;
      return handler;
    } catch (e) {
      console.error('Failed to create MCP handler', e);
      return null;
    }
  }

  async function handleMcp(req, res, url) {
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) return false;
    // Bind locally by default - check host is loopback if config.host is loopback
    // Do not expose externally by default; if config.host is 127.0.0.1, we still serve but origin validation will be done via handler
    if (!config.mcpEnabled) {
      json(res, 404, { error: 'MCP disabled', code: 'MCP_DISABLED' });
      return true;
    }
    // Auth check
    if (config.mcpToken && !mcpAuthorized(req)) {
      json(res, 401, { error: 'MCP authentication required', code: 'AUTH_REQUIRED' });
      return true;
    }
    const handler = await getMcpHandler();
    if (!handler) { json(res, 500, { error: 'MCP handler not available' }); return true; }
    // For Streamable HTTP, we need to handle POST /mcp (bounded body)
    const chunks = [];
    let mcpBytes = 0;
    for await (const chunk of req) {
      mcpBytes += chunk.length;
      if (mcpBytes > 1_000_000) {
        // Drain remaining request body to avoid hanging keep-alive socket
        req.resume();
        json(res, 413, { error: 'MCP request body too large', code: 'PAYLOAD_TOO_LARGE' });
        return true;
      }
      chunks.push(chunk);
    }
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(', '));
      else if (v) headers.set(k, v);
    }
    // Ensure content-type
    const reqUrl = `http://${req.headers.host || 'localhost'}${req.url}`;
    const webReq = new Request(reqUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' && body ? body : undefined,
    });
    try {
      const resp = await handler.fetch(webReq, { authInfo: mcpAuthorized(req) ? { clientId: 'mcp-client', token: config.mcpToken } : undefined });
      // Copy response to Node res
      res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
      if (resp.body) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        res.end(buffer);
      } else {
        res.end();
      }
      return true;
    } catch (e) {
      console.error('MCP handler error', e);
      if (!res.headersSent) json(res, 500, { error: e.message || 'MCP error' });
      else res.end();
      return true;
    }
  }

  async function api(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/health' && req.method === 'GET') { const librechat = await client.health(); return json(res, librechat.ok ? 200 : 503, { ok: librechat.ok, librechat, publicUrl: config.publicUrl || null }); }
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      try {
        const agents = await app.listAgents();
        return json(res, 200, { agents });
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      try {
        const workspaces = await app.listWorkspaces();
        return json(res, 200, { workspaces });
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const view = await app.createWorkspace(body);
        return json(res, 201, enrichView(view, req));
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    // MCP runtime status also exposed via REST for convenience
    if (url.pathname === '/api/mcp/status' && req.method === 'GET') {
      return json(res, 200, { enabled: Boolean(config.mcpEnabled), tokenConfigured: Boolean(config.mcpToken), endpoint: `http://${config.host}:${config.port}/mcp` });
    }
    if (url.pathname === '/api/mcp/token' && req.method === 'GET') {
      // Never return token; just indicate presence
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { configured: Boolean(config.mcpToken) });
    }

    const workspaceId = parts[2]; if (parts[0] !== 'api' || parts[1] !== 'workspaces' || !workspaceId) return false;
    if (parts.length === 3 && req.method === 'GET') {
      try { return json(res, 200, await getEnrichedWorkspace(workspaceId, req)); }
      catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts.length === 3 && req.method === 'PATCH') {
      try {
        const body = await readBody(req);
        // Map legacy names
        const patch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.globalPrompt !== undefined) patch.globalPrompt = body.globalPrompt;
        if (body.system_prompt !== undefined) patch.globalPrompt = body.system_prompt;
        if (body.defaultAgentId !== undefined) patch.defaultAgentId = body.defaultAgentId;
        if (body.default_agent_id !== undefined) patch.defaultAgentId = body.default_agent_id;
        if (body.compileAgentId !== undefined) patch.compileAgentId = body.compileAgentId;
        if (body.compile_agent_id !== undefined) patch.compileAgentId = body.compile_agent_id;
        if (body.compilePrompt !== undefined) patch.compilePrompt = body.compilePrompt;
        if (body.compile_prompt !== undefined) patch.compilePrompt = body.compile_prompt;
        if (body.settings !== undefined) patch.settings = body.settings;
        const view = await app.updateWorkspace(workspaceId, patch);
        return json(res, 200, enrichView(view, req));
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      try { await app.deleteWorkspace(workspaceId); return json(res, 204, null); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }

    if (parts[3] === 'members' && parts.length === 4 && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await app.addChat(workspaceId, body);
        result.workspace = enrichView(result.workspace, req);
        if (result.member) {
          const origin = publicOrigin(req);
          result.member.actionSpecUrl = `${origin}/tools/${workspaceId}/${result.member.id}/openapi.json`;
        }
        return json(res, 201, result);
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts[3] === 'members' && parts[4]) {
      const memberId = parts[4];
      if (parts.length === 5 && req.method === 'PATCH') {
        try {
          const body = await readBody(req);
          const view = await app.updateChat(workspaceId, memberId, body);
          return json(res, 200, enrichView(view, req));
        } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
      }
      if (parts.length === 5 && req.method === 'DELETE') {
        try { await app.deleteChat(workspaceId, memberId); return json(res, 204, null); }
        catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
      if (parts[5] === 'enqueue' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await app.send(workspaceId, memberId, body.prompt);
          try { store.appendEvent(workspaceId, { type: 'human.send', origin: 'human', memberId, detail: { prompt: String(body.prompt||'').slice(0,200) } }); } catch {}
          return json(res, 202, { item: result.item });
        } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
      }
      if (parts[5] === 'retry' && req.method === 'POST') {
        try { const view = await app.retryChat(workspaceId, memberId); return json(res, 202, enrichView(view, req)); }
        catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
      if (parts[5] === 'stop' && req.method === 'POST') {
        try {
          const view = await app.stopChat(workspaceId, memberId);
          try { store.appendEvent(workspaceId, { type: 'human.stop', origin: 'human', memberId }); } catch {}
          return json(res, 200, enrichView(view, req));
        }
        catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
    }
    if (parts[3] === 'broadcast' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await app.broadcast(workspaceId, body.prompt);
        try { store.appendEvent(workspaceId, { type: 'human.broadcast', origin: 'human', detail: { prompt: String(body.prompt||'').slice(0,200) } }); } catch {}
        return json(res, 202, { items: result.items, workspace: enrichView(result.workspace, req) });
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts[3] === 'stop' && req.method === 'POST') {
      try {
        const view = await app.stopWorkspace(workspaceId);
        try { store.appendEvent(workspaceId, { type: 'human.stop', origin: 'human', detail: { workspaceId } }); } catch {}
        return json(res, 200, enrichView(view, req));
      }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (parts[3] === 'compile' && req.method === 'POST') {
      try {
        const view = await app.compile(workspaceId);
        return json(res, 200, enrichView(view, req));
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts[3] === 'wait' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const timeout = body.timeout_seconds ?? body.timeout ?? 60;
        const interval = body.poll_interval_ms ?? body.interval ?? 500;
        const result = await app.waitUntilSettled(workspaceId, timeout, interval);
        return json(res, 200, result);
      } catch (e) { return json(res, e.status || 500, { error: e.message, code: e.code }); }
    }
    if (parts[3] === 'orchestrator' && req.method === 'GET') {
      try { return json(res, 200, store.getOrchestratorState(workspaceId)); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (parts[3] === 'orchestrator' && parts[4] === 'pause' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const paused = Boolean(body.paused);
        const v = store.setOrchestratorPaused(workspaceId, paused);
        return json(res, 200, { paused: v, orchestrator: store.getOrchestratorState(workspaceId) });
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (parts[3] === 'messages' && req.method === 'GET') {
      const chatId = url.searchParams.get('chat_id') || parts[4];
      if (!chatId) return json(res, 400, { error: 'chat_id required' });
      try {
        const limit = url.searchParams.get('limit');
        const since = url.searchParams.get('since');
        const msgs = await app.getChatMessages(workspaceId, chatId, { limit, since });
        return json(res, 200, { messages: msgs });
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    return false;
  }

  async function tools(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); if (parts[0] !== 'tools' || parts.length < 4) return false;
    const [, workspaceId, sourceMemberId, action] = parts; const { workspace, member: source } = store.requireMember(workspaceId, sourceMemberId);
    if (action === 'openapi.json' && req.method === 'GET') return json(res, 200, buildActionSpec({ origin: publicOrigin(req), workspace, member: source, requireSecret: Boolean(config.toolSecret) }));
    if (!toolAuthorized(req)) return json(res, 401, { error: 'Invalid tool key' });
    if (action === 'list-chats' && req.method === 'GET') {
      try {
        const chats = await app.listPeerChats(workspaceId, sourceMemberId);
        return json(res, 200, { chats });
      } catch (e) { return json(res, e.status || 400, { error: e.message, code: e.code }); }
    }
    if (action === 'inspect-chat' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await app.inspectPeerChat(workspaceId, sourceMemberId, body.target ?? body.target_member_id, body.query, Math.min(Number(body.limit) || config.maxInspectResults, 20));
        return json(res, 200, result);
      } catch (e) { return json(res, e.status || 400, { error: e.message, code: e.code }); }
    }
    if (action === 'send-to-chat' && req.method === 'POST') {
      try {
        const body = await readBody(req); const refs = Array.isArray(body.targets) ? body.targets : body.target_member_id ? [body.target_member_id] : [];
        const result = await app.sendToChats(workspaceId, sourceMemberId, refs, body.prompt);
        return json(res, 202, result);
      } catch (e) {
        return json(res, e.status || 400, { error: e.message, code: e.code });
      }
    }
    return false;
  }

  function staticFile(req, res, url) {
    if (req.method !== 'GET') return false;
    let relative;
    try { relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
    catch { return false; }
    const filePath = path.resolve(publicDir, relative); const rel = path.relative(publicDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
    const ext = path.extname(filePath); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res); return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      // MCP first (authenticated)
      if (url.pathname.startsWith('/mcp')) {
        const handled = await handleMcp(req, res, url);
        if (handled) return;
      }
      if (url.pathname.startsWith('/api/')) { const handled = await api(req, res, url); if (handled !== false) return; }
      if (url.pathname.startsWith('/tools/')) { const handled = await tools(req, res, url); if (handled !== false) return; }
      if (staticFile(req, res, url)) return; json(res, 404, { error: 'Not found' });
    } catch (error) { console.error(error); if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error', code: error.code }); else res.end(); }
  });
  // Expose for testing
  return { server, store, client, scheduler, workspaceView, app, config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(defaultConfig.port, defaultConfig.host, () => { app.scheduler.resumeAll(); console.log(`MultiContext Chat: http://${defaultConfig.host}:${defaultConfig.port}`); if (defaultConfig.mcpEnabled) console.log(`MCP endpoint: http://${defaultConfig.host}:${defaultConfig.port}/mcp`); });
}
