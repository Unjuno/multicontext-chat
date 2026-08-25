import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { StateStore, searchMemberMessages } from './store.js';
import { LibreChatClient } from './librechat.js';
import { Scheduler } from './scheduler.js';
import { buildActionSpec } from './openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const store = new StateStore(config.dataFile);
const client = new LibreChatClient({ baseUrl: config.librechatBaseUrl, apiKey: config.librechatApiKey, timeoutMs: config.agentTimeoutMs });
const scheduler = new Scheduler({ store, client, maxHistoryMessages: config.maxHistoryMessages });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};
const authorized = (req) => !config.appToken || req.headers.authorization === `Bearer ${config.appToken}`;
const toolAuthorized = (req) => !config.toolSecret || req.headers['x-multicontext-key'] === config.toolSecret;
const originOf = (req) => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

function workspaceView(id) {
  const workspace = store.requireWorkspace(id);
  return {
    ...store.publicWorkspace(workspace, true),
    settled: store.isSettled(id, scheduler.runningMemberIds(id)),
    runningMemberIds: [...scheduler.runningMemberIds(id)],
  };
}

async function api(req, res, url) {
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, librechatBaseUrl: config.librechatBaseUrl, apiKeyConfigured: Boolean(config.librechatApiKey) });
  }
  if (url.pathname === '/api/workspaces' && req.method === 'GET') return json(res, 200, { workspaces: store.listWorkspaces() });
  if (url.pathname === '/api/workspaces' && req.method === 'POST') return json(res, 201, workspaceView(store.createWorkspace(await readBody(req)).id));

  const workspaceId = parts[2];
  if (parts[0] !== 'api' || parts[1] !== 'workspaces' || !workspaceId) return false;

  if (parts.length === 3 && req.method === 'GET') return json(res, 200, workspaceView(workspaceId));
  if (parts.length === 3 && req.method === 'PATCH') { store.updateWorkspace(workspaceId, await readBody(req)); return json(res, 200, workspaceView(workspaceId)); }
  if (parts.length === 3 && req.method === 'DELETE') { scheduler.stopWorkspace(workspaceId); store.deleteWorkspace(workspaceId); return json(res, 204, {}); }

  if (parts[3] === 'members' && parts.length === 4 && req.method === 'POST') {
    const member = store.addMember(workspaceId, await readBody(req));
    return json(res, 201, { member, workspace: workspaceView(workspaceId) });
  }
  if (parts[3] === 'members' && parts[4]) {
    const memberId = parts[4];
    if (parts.length === 5 && req.method === 'PATCH') { store.updateMember(workspaceId, memberId, await readBody(req)); scheduler.kickMember(workspaceId, memberId); return json(res, 200, workspaceView(workspaceId)); }
    if (parts.length === 5 && req.method === 'DELETE') { store.deleteMember(workspaceId, memberId); return json(res, 204, {}); }
    if (parts[5] === 'enqueue' && req.method === 'POST') {
      const body = await readBody(req); const item = store.enqueue(workspaceId, memberId, body.prompt, { source: 'user' }); scheduler.kickMember(workspaceId, memberId); return json(res, 202, { item });
    }
  }
  if (parts[3] === 'broadcast' && req.method === 'POST') {
    const body = await readBody(req); const items = store.broadcast(workspaceId, body.prompt); scheduler.kickWorkspace(workspaceId); return json(res, 202, { items });
  }
  if (parts[3] === 'stop' && req.method === 'POST') { scheduler.stopWorkspace(workspaceId); return json(res, 200, workspaceView(workspaceId)); }
  if (parts[3] === 'compile' && req.method === 'POST') {
    const workspace = store.requireWorkspace(workspaceId);
    if (!store.isSettled(workspaceId, scheduler.runningMemberIds(workspaceId))) return json(res, 409, { error: 'Workspace is not SETTLED' });
    const agentId = workspace.compileAgentId || Object.values(workspace.members).find((m) => m.active)?.agentId;
    if (!agentId) return json(res, 400, { error: 'No compile agent is configured' });
    const snapshots = Object.values(workspace.members).filter((m) => m.active).map((m) => ({
      member: { id: m.id, name: m.name }, messages: m.messages.slice(-12).map(({ role, content, at }) => ({ role, content, at })),
    }));
    const result = await client.runAgent({
      agentId,
      globalPrompt: workspace.compilePrompt,
      developerPrompt: '',
      history: [],
      prompt: `Synthesize these independent deliberation records. Preserve provenance by member name.\n\n${JSON.stringify(snapshots, null, 2)}`,
      metadata: { workspace_id: workspaceId, purpose: 'compile' },
    });
    store.setCompile(workspaceId, { text: result.text, responseId: result.id, usage: result.usage });
    return json(res, 200, workspaceView(workspaceId));
  }
  return false;
}

async function tools(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'tools' || parts.length < 4) return false;
  const [_, workspaceId, sourceMemberId, action] = parts;
  const { workspace, member: source } = store.requireMember(workspaceId, sourceMemberId);
  if (action === 'openapi.json' && req.method === 'GET') {
    return json(res, 200, buildActionSpec({ origin: originOf(req), workspace, member: source, requireSecret: Boolean(config.toolSecret) }));
  }
  if (!toolAuthorized(req)) return json(res, 401, { error: 'Invalid tool key' });
  if (action === 'inspect-chat' && req.method === 'POST') {
    if (!workspace.settings.allowCrossChatInspect || !source.canInspectOthers) return json(res, 403, { error: 'Cross-chat inspection is disabled' });
    const body = await readBody(req); const target = workspace.members[body.target_member_id];
    if (!target) return json(res, 404, { error: 'Target member not found' });
    workspace.stats.inspections += 1; store.save();
    return json(res, 200, { target: { id: target.id, name: target.name }, results: searchMemberMessages(target, body.query, Math.min(Number(body.limit) || config.maxInspectResults, 20)), epistemic_note: 'Another agent claim is an argument/hypothesis, not evidence by itself.' });
  }
  if (action === 'send-to-chat' && req.method === 'POST') {
    if (!workspace.settings.allowCrossChatSend || !source.canSendOthers) return json(res, 403, { error: 'Cross-chat sending is disabled' });
    const body = await readBody(req); const target = workspace.members[body.target_member_id];
    if (!target) return json(res, 404, { error: 'Target member not found' });
    const item = store.enqueue(workspaceId, target.id, body.prompt, { source: 'tool', sourceMemberId });
    scheduler.kickMember(workspaceId, target.id);
    return json(res, 202, { accepted: true, queue_item_id: item.id, target: { id: target.id, name: target.name } });
  }
  return false;
}

function staticFile(req, res, url) {
  if (req.method !== 'GET') return false;
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) { const handled = await api(req, res, url); if (handled !== false) return; }
    if (url.pathname.startsWith('/tools/')) { const handled = await tools(req, res, url); if (handled !== false) return; }
    if (staticFile(req, res, url)) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error' });
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, config.host, () => console.log(`MultiContext Chat: http://${config.host}:${config.port}`));
}
