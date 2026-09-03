#!/usr/bin/env node
// multicontext-mcp-launcher: stdio MCP entry point with Desktop bootstrap.
//
// OpenCode (or any stdio MCP client) spawns this script instead of talking to
// http://127.0.0.1:4317/mcp directly:
//
//   1. If the MultiContext HTTP endpoint is already healthy, use it as-is
//      (single-instance reuse; never launches a second app).
//   2. Otherwise open MultiContext.app in the background (`open -g`, no focus
//      steal) and wait until /api/health reports ready.
//   3. Proxy newline-delimited JSON-RPC between stdio and Streamable HTTP,
//      tracking the Mcp-Session-Id across requests.
//
// Raw JSON-RPC pass-through: the launcher never interprets tool schemas, so it
// cannot drift from the server's tool registry.
//
// Env:
//   MULTICONTEXT_PORT (default 4317)
//   MULTICONTEXT_MCP_TOKEN (optional Bearer token; also X-MCP-Token fallback server-side)
//   MULTICONTEXT_APP_PATH (explicit .app path; otherwise /Applications then ~/Applications)
//   MULTICONTEXT_LAUNCH_TIMEOUT_MS (default 180000)
//   MULTICONTEXT_NO_LAUNCH=1 (fail fast instead of opening the app)
// Logs go to stderr only; stdout is reserved for JSON-RPC.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 4317;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180000;
export const DEFAULT_POLL_MS = 1500;

export function mcpUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/mcp`;
}

export function healthUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/api/health`;
}

export function resolveAppPath({ env = process.env, existsSync = fs.existsSync, home = os.homedir() } = {}) {
  const candidates = [
    env.MULTICONTEXT_APP_PATH,
    '/Applications/MultiContext.app',
    home ? path.join(home, 'Applications', 'MultiContext.app') : null,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function isAppRunning({ runner = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8' }) } = {}) {
  try {
    const result = runner(['pgrep', '-f', 'multicontext-desktop']);
    return result.status === 0 && String(result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

export async function isReady({ port = DEFAULT_PORT, token = null, fetchImpl = fetch } = {}) {
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(healthUrl(port), { headers });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReady({
  port = DEFAULT_PORT,
  token = null,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isReady({ port, token, fetchImpl })) return true;
    if (now() >= deadline) {
      throw new Error(`MultiContext at ${healthUrl(port)} did not become ready within ${timeoutMs}ms`);
    }
    await sleepImpl(pollMs);
  }
}

export function openAppInBackground(
  appPath,
  { runner = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8' }) } = {},
) {
  // -g: do not bring the app to the foreground.
  const result = runner(['open', '-g', '-a', appPath]);
  if (result.status !== 0) {
    throw new Error(`Failed to open ${appPath}: ${result.stderr || result.error || result.status}`);
  }
}

// Ensure a healthy endpoint, launching the Desktop app once if needed.
// Returns { launched: boolean }.
export async function ensureReady({
  port = DEFAULT_PORT,
  token = null,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  noLaunch = false,
  deps = {},
} = {}) {
  if (await isReady({ port, token, fetchImpl: deps.fetchImpl })) return { launched: false };
  if (noLaunch) throw new Error(`MultiContext at ${healthUrl(port)} is not ready and MULTICONTEXT_NO_LAUNCH=1`);
  const appPath = resolveAppPath({ env: deps.env, existsSync: deps.existsSync, home: deps.home });
  if (!appPath) {
    throw new Error('MultiContext is not running and no MultiContext.app was found (set MULTICONTEXT_APP_PATH)');
  }
  if (!isAppRunning({ runner: deps.runner })) {
    openAppInBackground(appPath, { runner: deps.runner });
  }
  await waitForReady({ port, token, timeoutMs, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl, now: deps.now });
  return { launched: true };
}

function tryParseJson(text) {
  try {
    return { value: JSON.parse(text), ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

function isJsonRpcMessage(value) {
  return value !== null && typeof value === 'object' && value.jsonrpc === '2.0';
}

// Map one HTTP response into session updates + stdio output lines (pure).
export function mapHttpResponseToStdio({ status, headers = {}, bodyText = '', requestId = null }) {
  const sessionId =
    headers['mcp-session-id'] || headers['Mcp-Session-Id'] || headers['MCP-SESSION-ID'] || null;
  const outLines = [];
  if (!bodyText) return { sessionId, outLines };
  if (bodyText.includes('event:') || bodyText.includes('data:')) {
    for (const line of bodyText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') continue;
      outLines.push(payload);
    }
    return { sessionId, outLines };
  }
  const parsed = tryParseJson(bodyText);
  if (parsed.ok && (isJsonRpcMessage(parsed.value) || Array.isArray(parsed.value))) {
    outLines.push(JSON.stringify(parsed.value));
    return { sessionId, outLines };
  }
  // Non-JSON-RPC body (e.g. plain {error} with 4xx): wrap so the stdio client
  // still receives a well-formed JSON-RPC error correlated to its request.
  outLines.push(JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    error: { code: -32000, message: `MultiContext MCP HTTP ${status}: ${bodyText.slice(0, 300)}` },
  }));
  return { sessionId, outLines };
}

export function requestIdOf(line) {
  const parsed = tryParseJson(line);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return null;
  return Array.isArray(parsed.value) ? null : (parsed.value.id ?? null);
}

// MCP methods that start a user-visible experiment. Only these trigger a
// Desktop focus hint (workspace navigation + window front); routine traffic
// such as broadcasts, sends, or status polls must never steal focus.
export const FOCUS_METHODS = new Set([
  'multicontext_create_workspace',
  'multicontext_orchestrate_create_session',
  'multicontext_orchestrate_start_run',
  'multicontext_orchestrate_run',
]);

function digWorkspaceId(value, method = null) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.workspace_id === 'string') return value.workspace_id;
  if (value.workspace && typeof value.workspace.id === 'string') return value.workspace.id;
  // multicontext_create_workspace returns the workspace itself, not wrapped.
  if (method === 'multicontext_create_workspace' && typeof value.id === 'string') return value.id;
  return null;
}

function digRunId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.run_id === 'string') return value.run_id;
  if (value.run && typeof value.run.id === 'string') return value.run.id;
  return null;
}

function structuredResultsOf(outLines) {
  const results = [];
  for (const line of outLines) {
    const parsed = tryParseJson(line);
    if (!parsed.ok) continue;
    const values = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    for (const value of values) {
      if (value !== null && typeof value === 'object' && 'result' in value) results.push(value.result);
    }
  }
  return results;
}

function contentJsonOf(result) {
  try {
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return null;
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Decide whether an MCP exchange starts an experiment worth showing in the
// Desktop GUI. Returns { workspace_id, run_id } or null. Pure.
export function focusTargetOf({ method, params, outLines }) {
  if (!FOCUS_METHODS.has(method)) return null;
  let workspace_id = (params !== null && typeof params === 'object' && typeof params.workspace_id === 'string')
    ? params.workspace_id
    : null;
  let run_id = null;
  for (const result of structuredResultsOf(outLines)) {
    workspace_id = workspace_id || digWorkspaceId(result, method) || digWorkspaceId(contentJsonOf(result), method);
    const foundRun = digRunId(result) || digRunId(contentJsonOf(result));
    run_id = run_id || foundRun;
  }
  if (!workspace_id) return null;
  return { workspace_id, run_id };
}

export async function notifyFocus({ port = DEFAULT_PORT, token = null, workspace_id, run_id = null, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/workspaces/${workspace_id}/focus`, {
    method: 'POST', headers, body: JSON.stringify({ run_id, reason: 'mcp-experiment-start' }),
  });
  if (!response.ok) throw new Error(`focus hint HTTP ${response.status}`);
  return true;
}

// Bring the Desktop app to the foreground when a new experiment starts.
// Only ever called for experiment-start focus hints, never for routine
// traffic. Best-effort: failures are swallowed by the caller.
export function frontApp({ env = process.env, existsSync = fs.existsSync, home = os.homedir(), runner = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8' }) } = {}) {
  const appPath = resolveAppPath({ env, existsSync, home });
  if (!appPath) return false;
  const result = runner(['open', '-a', appPath]);
  return result.status === 0;
}

export async function forwardOneLine({ line, endpoint, token, sessionId, fetchImpl = fetch }) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetchImpl(endpoint, { method: 'POST', headers, body: line });
  const bodyText = await response.text();
  const headerMap = {};
  response.headers?.forEach?.((value, key) => { headerMap[key] = value; });
  return mapHttpResponseToStdio({
    status: response.status,
    headers: headerMap,
    bodyText,
    requestId: requestIdOf(line),
  });
}

async function readStdinLines(onLine) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      await onLine(line);
    }
  }
}

export async function runLauncher({ env = process.env, fetchImpl = fetch, stdin = true } = {}) {
  const port = Number.parseInt(env.MULTICONTEXT_PORT || '', 10) || DEFAULT_PORT;
  const token = env.MULTICONTEXT_MCP_TOKEN || null;
  const timeoutMs = Number.parseInt(env.MULTICONTEXT_LAUNCH_TIMEOUT_MS || '', 10) || DEFAULT_LAUNCH_TIMEOUT_MS;
  const noLaunch = env.MULTICONTEXT_NO_LAUNCH === '1';
  const ensured = await ensureReady({
    port, token, timeoutMs, noLaunch, deps: { fetchImpl, env },
  });
  const endpoint = mcpUrl(port);
  console.error(`[multicontext-mcp-launcher] endpoint ready: ${endpoint} (launched=${ensured.launched})`);
  let sessionId = null;
  const writeLine = (text) => process.stdout.write(`${text}\n`);
  await readStdinLines(async (line) => {
    let method = null;
    let params = null;
    try {
      const parsed = tryParseJson(line);
      if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        if (parsed.value.method === 'tools/call') {
          method = parsed.value.params?.name ?? null;
          params = parsed.value.params?.arguments ?? null;
        }
      }
      const mapped = await forwardOneLine({ line, endpoint, token, sessionId, fetchImpl });
      if (mapped.sessionId) sessionId = mapped.sessionId;
      for (const out of mapped.outLines) writeLine(out);
      const focus = focusTargetOf({ method, params, outLines: mapped.outLines });
      if (focus) {
        // Fire-and-forget: focus UX must never break MCP proxying.
        notifyFocus({ port, token, workspace_id: focus.workspace_id, run_id: focus.run_id, fetchImpl })
          .then(() => frontApp())
          .catch((error) => console.error(`[multicontext-mcp-launcher] focus hint failed: ${error.message}`));
      }
    } catch (error) {
      writeLine(JSON.stringify({
        jsonrpc: '2.0', id: requestIdOf(line),
        error: { code: -32000, message: `launcher forward failed: ${error.message}` },
      }));
    }
  });
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  runLauncher().catch((error) => {
    console.error(`[multicontext-mcp-launcher] fatal: ${error.message}`);
    process.exit(1);
  });
}
