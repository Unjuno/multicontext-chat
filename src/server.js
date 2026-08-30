import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.js';
import { StateStore, searchMemberMessages, publicMember } from './store.js';
import { LibreChatClient } from './librechat.js';
import { Scheduler } from './scheduler.js';
import { buildActionSpec } from './openapi.js';

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

  const authorized = (req) => !config.appToken || req.headers.authorization === `Bearer ${config.appToken}`;
  const toolAuthorized = (req) => !config.toolSecret || req.headers['x-multicontext-key'] === config.toolSecret;
  const compilingWorkspaces = new Set();
  let cachedDefaultAgentId = null;
  let cachedDefaultAgentFetchedAt = 0;
  async function getResolvedDefaultAgentId() {
    const now = Date.now();
    if (cachedDefaultAgentId && now - cachedDefaultAgentFetchedAt < 30000) return cachedDefaultAgentId;
    try {
      const agents = await client.listAgents();
      if (agents && agents.length) {
        agents.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
        const chosen = String(agents[0].id || '');
        if (chosen) {
          cachedDefaultAgentId = chosen;
          cachedDefaultAgentFetchedAt = now;
          return chosen;
        }
      }
    } catch {}
    return '';
  }
  async function ensureWorkspaceDefaultAgent(workspaceId) {
    const workspace = store.requireWorkspace(workspaceId);
    if (workspace.defaultAgentId) return workspace.defaultAgentId;
    const resolved = await getResolvedDefaultAgentId();
    if (resolved) {
      store.updateWorkspace(workspaceId, { defaultAgentId: resolved });
      return resolved;
    }
    return '';
  }
  function effectiveAgentIdForMember(workspace, member) {
    return String(member.agentId || workspace.defaultAgentId || '').trim();
  }
  const requestOrigin = (req) => {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    if (proto !== 'http' && proto !== 'https') return null;
    const host = req.headers.host;
    if (!host) return null;
    return `${proto}://${host}`;
  };
  const publicOrigin = (req) => config.publicUrl || requestOrigin(req) || `http://${config.host}:${config.port}`;

  const workspaceView = (id, req) => {
    const workspace = store.requireWorkspace(id); const runtimeState = store.runtimeState(id, scheduler.runningMemberIds(id));
    return { ...store.publicWorkspace(workspace, true), runtimeState, settled: runtimeState === 'SETTLED', runningMemberIds: [...scheduler.runningMemberIds(id)],
      members: Object.fromEntries(Object.entries(workspace.members).map(([mid, m]) => [mid, { ...publicMember(m), actionSpecUrl: `${publicOrigin(req)}/tools/${id}/${mid}/openapi.json` }])) };
  };

  async function api(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/health' && req.method === 'GET') { const librechat = await client.health(); return json(res, librechat.ok ? 200 : 503, { ok: librechat.ok, librechat, publicUrl: config.publicUrl || null }); }
    if (url.pathname === '/api/agents' && req.method === 'GET') return json(res, 200, { agents: await client.listAgents() });
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      const workspaces = store.listWorkspaces().map((w) => {
        const runtimeState = store.runtimeState(w.id, scheduler.runningMemberIds(w.id));
        return { ...w, runtimeState, settled: runtimeState === 'SETTLED' };
      });
      return json(res, 200, { workspaces });
    }
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const body = await readBody(req);
      const workspace = store.createWorkspace(body);
      if (!workspace.defaultAgentId) {
        const resolved = await getResolvedDefaultAgentId();
        if (resolved) store.updateWorkspace(workspace.id, { defaultAgentId: resolved });
      }
      return json(res, 201, workspaceView(workspace.id, req));
    }

    const workspaceId = parts[2]; if (parts[0] !== 'api' || parts[1] !== 'workspaces' || !workspaceId) return false;
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, workspaceView(workspaceId, req));
    if (parts.length === 3 && req.method === 'PATCH') { store.updateWorkspace(workspaceId, await readBody(req)); return json(res, 200, workspaceView(workspaceId, req)); }
    if (parts.length === 3 && req.method === 'DELETE') { scheduler.stopWorkspace(workspaceId); store.deleteWorkspace(workspaceId); return json(res, 204, null); }

    if (parts[3] === 'members' && parts.length === 4 && req.method === 'POST') {
      const body = await readBody(req);
      // If member has no explicit agent and workspace has no default, try to ensure workspace default
      const workspace = store.requireWorkspace(workspaceId);
      if (!body.agentId && !workspace.defaultAgentId) {
        await ensureWorkspaceDefaultAgent(workspaceId);
      }
      const member = store.addMember(workspaceId, body);
      return json(res, 201, { member: publicMember(member), workspace: workspaceView(workspaceId, req) });
    }
    if (parts[3] === 'members' && parts[4]) {
      const memberId = parts[4];
      if (parts.length === 5 && req.method === 'PATCH') {
        const body = await readBody(req); const existing = store.requireMember(workspaceId, memberId).member;
        if (body.active === false && existing.active) scheduler.stopMember(workspaceId, memberId);
        store.updateMember(workspaceId, memberId, body); scheduler.kickMember(workspaceId, memberId); return json(res, 200, workspaceView(workspaceId, req));
      }
      if (parts.length === 5 && req.method === 'DELETE') { scheduler.stopMember(workspaceId, memberId); store.deleteMember(workspaceId, memberId); return json(res, 204, null); }
      if (parts[5] === 'enqueue' && req.method === 'POST') {
        const body = await readBody(req);
        const workspace = store.requireWorkspace(workspaceId);
        const member = workspace.members[memberId];
        if (!member) return json(res, 404, { error: 'Member not found' });
        let effective = effectiveAgentIdForMember(workspace, member);
        if (!effective) {
          const resolved = await ensureWorkspaceDefaultAgent(workspaceId);
          const updatedWorkspace = store.requireWorkspace(workspaceId);
          const updatedMember = updatedWorkspace.members[memberId];
          effective = effectiveAgentIdForMember(updatedWorkspace, updatedMember);
          if (!effective && !resolved) {
            // Try one more direct resolve for immediate feedback
            const directResolved = await getResolvedDefaultAgentId();
            if (!directResolved) return json(res, 400, { error: '利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。' });
            // If we got a resolved id but workspace still empty (list may have been empty earlier), set it
            if (!updatedWorkspace.defaultAgentId) store.updateWorkspace(workspaceId, { defaultAgentId: directResolved });
            effective = String(directResolved);
          }
          if (!effective) return json(res, 400, { error: '利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。' });
        }
        // Auto-recover BLOCKED config error if now resolvable
        const freshAfter = store.requireWorkspace(workspaceId).members[memberId];
        if (freshAfter.status === 'error' && freshAfter.lastError && (String(freshAfter.lastError).includes('利用可能なLibreChat Agent') || String(freshAfter.lastError).includes('LibreChat agentId is required'))) {
          if (effective) try { store.retryMember(workspaceId, memberId); } catch {}
        }
        const item = store.enqueue(workspaceId, memberId, body.prompt, { source: 'user' }); scheduler.kickMember(workspaceId, memberId); return json(res, 202, { item });
      }
      if (parts[5] === 'retry' && req.method === 'POST') { scheduler.retryMember(workspaceId, memberId); return json(res, 202, workspaceView(workspaceId, req)); }
      if (parts[5] === 'stop' && req.method === 'POST') { scheduler.stopMember(workspaceId, memberId); return json(res, 200, workspaceView(workspaceId, req)); }
    }
    if (parts[3] === 'broadcast' && req.method === 'POST') {
      const body = await readBody(req);
      const workspace = store.requireWorkspace(workspaceId);
      const activeMembers = Object.values(workspace.members).filter(m => m.active);
      if (!activeMembers.length) return json(res, 409, { error: 'No active members' });
      // Ensure workspace has a default agent if needed
      const needsDefault = activeMembers.some(m => !effectiveAgentIdForMember(workspace, m));
      if (needsDefault && !workspace.defaultAgentId) {
        await ensureWorkspaceDefaultAgent(workspaceId);
      }
      const updatedWorkspace = store.requireWorkspace(workspaceId);
      const stillNeedsAgent = activeMembers.some(m => {
        const freshMember = updatedWorkspace.members[m.id];
        return !effectiveAgentIdForMember(updatedWorkspace, freshMember);
      });
      if (stillNeedsAgent) {
        const directResolved = await getResolvedDefaultAgentId();
        if (!directResolved) return json(res, 400, { error: '利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。' });
        if (!updatedWorkspace.defaultAgentId) store.updateWorkspace(workspaceId, { defaultAgentId: directResolved });
      }
      // Final check: if any active member still has no effective agent, fail before queuing
      const finalWorkspace = store.requireWorkspace(workspaceId);
      const invalid = activeMembers.filter(m => !effectiveAgentIdForMember(finalWorkspace, finalWorkspace.members[m.id]));
      if (invalid.length) {
        return json(res, 400, { error: '利用可能なLibreChat Agentがありません。LibreChatでAgentを作成するか、設定からAgentを選択してください。' });
      }
      // Auto-recover members that were BLOCKED solely due to missing Agent (now resolvable)
      for (const m of activeMembers) {
        const fresh = finalWorkspace.members[m.id];
        if (fresh.status === 'error' && fresh.lastError && (String(fresh.lastError).includes('利用可能なLibreChat Agent') || String(fresh.lastError).includes('LibreChat agentId is required'))) {
          if (effectiveAgentIdForMember(finalWorkspace, fresh)) {
            try { store.retryMember(workspaceId, m.id); } catch {}
          }
        }
      }
      const items = store.broadcast(workspaceId, body.prompt); scheduler.kickWorkspace(workspaceId); return json(res, 202, { items });
    }
    if (parts[3] === 'stop' && req.method === 'POST') { scheduler.stopWorkspace(workspaceId); return json(res, 200, workspaceView(workspaceId, req)); }
    if (parts[3] === 'compile' && req.method === 'POST') {
      const workspace = store.requireWorkspace(workspaceId);
      if (!store.isSettled(workspaceId, scheduler.runningMemberIds(workspaceId))) return json(res, 409, { error: 'Workspace is not SETTLED' });
      if (compilingWorkspaces.has(workspaceId)) return json(res, 409, { error: 'Compile already in progress' });
      const agentId = workspace.compileAgentId || Object.values(workspace.members).find((m) => m.active)?.agentId;
      if (!agentId) return json(res, 400, { error: 'No compile agent is configured' });
      compilingWorkspaces.add(workspaceId);
      try {
        const snapshots = Object.values(workspace.members).filter((m) => m.active).map((m) => ({ member: { id: m.id, name: m.name }, messages: m.messages.filter((x) => !x.pending).slice(-12).map(({ role, content, at }) => ({ role, content, at })) }));
        const result = await client.runAgent({ agentId, globalPrompt: workspace.compilePrompt, developerPrompt: '', history: [], prompt: `Compress these independent chat records into a response for the user.\n\n${JSON.stringify(snapshots, null, 2)}`, metadata: { workspace_id: workspaceId, purpose: 'compile' } });
        store.setCompile(workspaceId, { text: result.text, responseId: result.id, usage: result.usage }); return json(res, 200, workspaceView(workspaceId, req));
      } finally { compilingWorkspaces.delete(workspaceId); }
    }
    return false;
  }

  async function tools(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); if (parts[0] !== 'tools' || parts.length < 4) return false;
    const [, workspaceId, sourceMemberId, action] = parts; const { workspace, member: source } = store.requireMember(workspaceId, sourceMemberId);
    if (action === 'openapi.json' && req.method === 'GET') return json(res, 200, buildActionSpec({ origin: publicOrigin(req), workspace, member: source, requireSecret: Boolean(config.toolSecret) }));
    if (!toolAuthorized(req)) return json(res, 401, { error: 'Invalid tool key' });
    if (action === 'list-chats' && req.method === 'GET') return json(res, 200, { chats: Object.values(workspace.members).filter((m) => m.active && m.id !== source.id).map((m) => ({ id: m.id, name: m.name })) });
    if (action === 'inspect-chat' && req.method === 'POST') {
      if (!workspace.settings.allowCrossChatInspect || !source.canInspectOthers) return json(res, 403, { error: 'Cross-chat inspection is disabled' });
      const body = await readBody(req); const target = store.resolveMember(workspaceId, body.target ?? body.target_member_id, { activeOnly: true });
      if (target.id === source.id) return json(res, 400, { error: 'Target must be another chat' });
      workspace.stats.inspections += 1; store.save();
      return json(res, 200, { target: { id: target.id, name: target.name }, results: searchMemberMessages(target, body.query, Math.min(Number(body.limit) || config.maxInspectResults, 20)) });
    }
    if (action === 'send-to-chat' && req.method === 'POST') {
      if (!workspace.settings.allowCrossChatSend || !source.canSendOthers) return json(res, 403, { error: 'Cross-chat sending is disabled' });
      const body = await readBody(req); const refs = Array.isArray(body.targets) ? body.targets : body.target_member_id ? [body.target_member_id] : [];
      if (refs.length < 1 || refs.length > 2) return json(res, 400, { error: 'targets must contain one or two chats' });
      const targets = refs.map((ref) => store.resolveMember(workspaceId, ref, { activeOnly: true }));
      if (new Set(targets.map((m) => m.id)).size !== targets.length) return json(res, 400, { error: 'Targets must be unique' });
      if (targets.some((m) => m.id === source.id)) return json(res, 400, { error: 'Target must be another chat' });
      const items = targets.map((target) => ({ target: { id: target.id, name: target.name }, item: store.enqueue(workspaceId, target.id, body.prompt, { source: 'tool', sourceMemberId }) }));
      for (const target of targets) scheduler.kickMember(workspaceId, target.id);
      return json(res, 202, { accepted: true, deliveries: items.map(({ target, item }) => ({ target, queue_item_id: item.id })) });
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
      if (url.pathname.startsWith('/api/')) { const handled = await api(req, res, url); if (handled !== false) return; }
      if (url.pathname.startsWith('/tools/')) { const handled = await tools(req, res, url); if (handled !== false) return; }
      if (staticFile(req, res, url)) return; json(res, 404, { error: 'Not found' });
    } catch (error) { console.error(error); if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error' }); else res.end(); }
  });
  return { server, store, client, scheduler, workspaceView };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(defaultConfig.port, defaultConfig.host, () => { app.scheduler.resumeAll(); console.log(`MultiContext Chat: http://${defaultConfig.host}:${defaultConfig.port}`); });
}
