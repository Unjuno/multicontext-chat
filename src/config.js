import path from 'node:path';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const mode = process.env.MULTICONTEXT_LIBRECHAT_MODE || 'native';
if (!['compat', 'native'].includes(mode)) throw new Error('MULTICONTEXT_LIBRECHAT_MODE must be compat or native');

export function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

export const config = {
  host: process.env.MULTICONTEXT_HOST || '127.0.0.1',
  port: int(process.env.MULTICONTEXT_PORT, 4317),
  dataFile: path.resolve(process.env.MULTICONTEXT_DATA_FILE || './data/state.json'),
  appToken: process.env.MULTICONTEXT_APP_TOKEN || '',
  toolSecret: process.env.MULTICONTEXT_TOOL_SECRET || '',
  publicUrl: (process.env.MULTICONTEXT_PUBLIC_URL || '').replace(/\/$/, ''),
  librechatBaseUrl: (process.env.LIBRECHAT_BASE_URL || 'http://localhost:3080').replace(/\/$/, ''),
  librechatApiKey: process.env.LIBRECHAT_API_KEY || '',
  librechatMode: mode,
  maxHistoryMessages: int(process.env.MULTICONTEXT_MAX_HISTORY_MESSAGES, 120),
  maxInspectResults: int(process.env.MULTICONTEXT_MAX_INSPECT_RESULTS, 8),
  agentTimeoutMs: int(process.env.MULTICONTEXT_AGENT_TIMEOUT_MS, 900000),
  mcpToken: process.env.MULTICONTEXT_MCP_TOKEN || '',
  mcpEnabled: process.env.MULTICONTEXT_MCP_ENABLED !== 'false',
  mcpHost: process.env.MULTICONTEXT_MCP_HOST || process.env.MULTICONTEXT_HOST || '127.0.0.1',
};

export function validateMcpConfig(cfg = config) {
  if (!cfg.mcpEnabled) return;
  if (!cfg.mcpToken && (!isLoopback(cfg.host) || !isLoopback(cfg.mcpHost))) {
    throw new Error('MCP enabled with non-loopback bind requires MULTICONTEXT_MCP_TOKEN (unsafe to expose unauthenticated MCP). Set a token or bind to 127.0.0.1/localhost/::1 or set MULTICONTEXT_MCP_ENABLED=false');
  }
}
validateMcpConfig();

if (!config.publicUrl) {
  console.warn('[multicontext] MULTICONTEXT_PUBLIC_URL not set — Action/OpenAPI origins will be derived from request headers (safe for local dev, not for public deployment)');
}
