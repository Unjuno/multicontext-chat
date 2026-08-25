import path from 'node:path';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  host: process.env.MULTICONTEXT_HOST || '127.0.0.1',
  port: int(process.env.MULTICONTEXT_PORT, 4317),
  dataFile: path.resolve(process.env.MULTICONTEXT_DATA_FILE || './data/state.json'),
  appToken: process.env.MULTICONTEXT_APP_TOKEN || '',
  toolSecret: process.env.MULTICONTEXT_TOOL_SECRET || '',
  librechatBaseUrl: (process.env.LIBRECHAT_BASE_URL || 'http://localhost:3080').replace(/\/$/, ''),
  librechatApiKey: process.env.LIBRECHAT_API_KEY || '',
  maxHistoryMessages: int(process.env.MULTICONTEXT_MAX_HISTORY_MESSAGES, 120),
  maxInspectResults: int(process.env.MULTICONTEXT_MAX_INSPECT_RESULTS, 8),
  agentTimeoutMs: int(process.env.MULTICONTEXT_AGENT_TIMEOUT_MS, 900000),
};
