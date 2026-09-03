# External Control MCP for MultiContext

**What this is:** A thin control adapter that exposes MultiContext itself as an MCP server so external coding/agent clients (OpenCode, Cursor, Claude Code, other MCP-compatible hosts) can configure and operate workspaces programmatically.

**What it is NOT:** LibreChat Agent MCP. LibreChat's own MCP lets an Agent use tools *while generating*. This server lets an *external application* control MultiContext (workspaces, queues, broadcast) which then talks to LibreChat → GPT-OSS.

```
OpenCode / external MCP client
        ↓  Streamable HTTP + Bearer token
MultiContext Control MCP  (this document)
        ↓
existing MultiContext application operations (src/application.js)
        ↓
workspace / FIFO queues / scheduler
        ↓
LibreChat (Remote Agents)
        ↓
GPT-OSS (llama.cpp)
```

## Architecture

- **Thin adapter:** `src/mcp/handler.js` registers 19 tools on a `McpServer` from `@modelcontextprotocol/server` (v2, 2026-07-28 spec). Each tool directly calls `src/application.js` which is the single source of truth for workspace state, agent resolution, broadcast validation, compile gating, etc. `src/server.js` (REST) and `src/mcp/*` (MCP) share that layer; no second orchestration copy.
- **Transport:** Streamable HTTP integrated into the existing Node server (`http://127.0.0.1:<port>/mcp`). Created via `createMcpHandler` → `handler.fetch(Request)` wrapped for `node:http`. No second daemon. An optional stdio bridge could reuse the same registry but is not required for the normal Desktop path.
- **Binding:** Default host remains loopback (`127.0.0.1`). The handler validates `Host`/`Origin` via `@modelcontextprotocol/node` guards when mounted behind plain `node:http`; framework wrappers (`express`/`hono`/`fastify`) would arm them by default. Do not expose MCP beyond localhost without understanding DNS rebinding and credential exposure.
- **Spec version:** Tested against `@modelcontextprotocol/server` 1.x (v2 SDK, Streamable HTTP) and `@modelcontextprotocol/client` 1.x. Configuration examples below use OpenCode's current remote MCP format (December 2025 docs, verified 2026-01-30).

## Enable / Disable

Desktop Settings → **外部連携 — MCP Server**

- `[✓] 有効` — `mcp_enabled` in `~/Library/Application Support/com.unjuno.multicontext/config.json` (default `true` for new installs, migrated `true` for old configs without the key).
- First enable with no token → a 64-char hex token is auto-generated via `/dev/urandom` and stored in macOS Keychain (`security` generic password, service `com.unjuno.multicontext`, account `multicontext_mcp_token`), never in `config.json`.
- Status badge: `利用可能` (enabled+token), `要設定` (enabled but token missing), `無効` (disabled).
- Endpoint shown: `http://127.0.0.1:4317/mcp` (port follows `multicontext_port`).
- Buttons: `OpenCode設定をコピー`, `接続情報をコピー`, `トークンを再生成` (generates new 64-char hex, overwrites Keychain), `無効化` (`set_mcp_enabled false`).

If disabled, `POST /mcp` returns `404 MCP_DISABLED`; existing LLM generation remains usable (MCP is optional, not part of AI Stack aggregate readiness).

Node env alternative (no Desktop):
```bash
MULTICONTEXT_MCP_TOKEN=$(openssl rand -hex 32)
MULTICONTEXT_MCP_ENABLED=true node --env-file=.env src/server.js
```

## Endpoint & Authentication

- **Endpoint:** `http://127.0.0.1:4317/mcp` (Streamable HTTP, POST with `Accept: application/json, text/event-stream`, JSON-RPC 2.0).
- **Auth:** `MULTICONTEXT_MCP_TOKEN` — a distinct MultiContext control credential (not LibreChat API key, not provider keys, not Remote Agents key). Sent as `Authorization: Bearer <token>` or `X-MCP-Token: <token>`. The server checks `config.mcpToken` (from env or Keychain injection) on every MCP request; `401 AUTH_REQUIRED` if missing/wrong. Tool secrets (`MULTICONTEXT_TOOL_SECRET` for LibreChat Actions) remain separate.
- **Storage:** Desktop stores the MCP token in Keychain only; `config.json` never contains it, logs redact `mcp_token`/`multicontext_mcp`, runtime status `/api/mcp/status` only reports `{enabled, tokenConfigured, endpoint}`.
- **Regeneration:** `generate_mcp_token` Tauri command overwrites Keychain; if MultiContext is Desktop-owned it is automatically restarted to pick up the new `MULTICONTEXT_MCP_TOKEN` env (no manual relaunch needed); if it is external (not in `Managed` map) it is never killed — the change takes effect after you restart the external `node src/server.js` process. The same applies to `set_mcp_enabled` toggling. Copy actions may temporarily expose the full token in clipboard — this is intentional for one-time paste into the client config.
- **Production bundle:** `npm run build:server` (esbuild, `dist/server.bundle.mjs` ~1MB, `src` ESM + `@modelcontextprotocol/*` + `zod` inlined) is self-contained. Tauri `beforeBuildCommand` builds it and bundles `dist/` as `multicontext/dist` resources; the Desktop `MultiContext.app` therefore runs `/mcp` without a checkout or `node_modules` — bare `import '@modelcontextprotocol/server'` never reaches the production filesystem.
- **Discovery vs zero:** `GET /api/agents` and `multicontext_list_agents` now use fresh discovery (`503 DISCOVERY_FAILED` on fetch/auth/timeout) instead of returning a stale cached 200. UI/MCP show “Agent取得に失敗” rather than stale list when LibreChat is down.
- **Body limit:** `POST /mcp` enforces the same 1 MB bound as `readBody()` for REST; larger payloads return `413 PAYLOAD_TOO_LARGE`.
- **Logging:** `src-tauri/src/process.rs::redact` and `src-tauri/src/main.rs::get_logs` redact `sk-`, `bearer`, `mcp_token`, etc.; MCP responses never include `LIBRECHAT_API_KEY`, `MULTICONTEXT_MCP_TOKEN`, `conversationId`, `current`, `lastRun`.

## OpenCode Setup

OpenCode uses `opencode.json` (`~/.config/opencode/opencode.json` global or `./opencode.json` project) with key `mcp`. Remote servers use `type: "remote"`.

**Generate from Desktop:** Settings → `OpenCode設定をコピー` calls `get_opencode_config` (Rust) which returns:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "multicontext": {
      "type": "remote",
      "url": "http://127.0.0.1:4317/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <64-hex-token>"
      }
    }
  }
}
```

Paste into `opencode.json` and restart OpenCode. Verify with `/mcps` in OpenCode — `multicontext` should appear.

**Desktop bootstrap (recommended):** the remote entry above fails when no
MultiContext server is running — it cannot start `MultiContext.app` by itself.
`scripts/multicontext-mcp-launcher.mjs` is a stdio MCP entry point that fixes
this without changing the server: it checks `/api/health`, opens
`MultiContext.app` in the background (`open -g`, no focus steal) only when
nothing is listening, waits until `/mcp` is ready, reuses an already-running
instance otherwise (single-instance; never launches a second app), then proxies
newline-delimited JSON-RPC between stdio and Streamable HTTP (tracking
`Mcp-Session-Id`). It never interprets tool schemas, so it cannot drift from
the server registry; non-JSON-RPC HTTP bodies are wrapped as JSON-RPC errors.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "multicontext": {
      "type": "local",
      "command": ["node", "/path/to/multicontext-chat/scripts/multicontext-mcp-launcher.mjs"],
      "environment": { "MULTICONTEXT_MCP_TOKEN": "YOUR_TOKEN_HERE" },
      "enabled": true
    }
  }
}
```

Env: `MULTICONTEXT_PORT` (default 4317), `MULTICONTEXT_MCP_TOKEN` (Bearer;
required when the Desktop app configured one — copy it from the Desktop
`OpenCode設定をコピー` output), `MULTICONTEXT_APP_PATH` (explicit `.app`
path; default resolution: env → `/Applications/MultiContext.app` →
`~/Applications/MultiContext.app`),
`MULTICONTEXT_LAUNCH_TIMEOUT_MS` (default 180000),
`MULTICONTEXT_NO_LAUNCH=1` (fail fast instead of opening the app).
Logs go to stderr; stdout is JSON-RPC only.

**Experiment → GUI attach:** when a proxied call starts a user-visible
experiment (`create_workspace`, `orchestrate_create_session`,
`orchestrate_start_run`, `orchestrate_run`), the launcher records a focus hint
(`POST /api/workspaces/:id/focus`) and brings the Desktop app forward
(`open -a`, no `-g`). The GUI consumes the hint once (2.5s poll), selects the
workspace, and shows live member/run/tool state there. Routine traffic
(broadcast, send, status, inspection) never sets the hint and never steals
focus. Server endpoint `GET /api/focus/pending` is consume-once; the hint is
in-memory only and never persisted into workspace state.

**Manual minimal:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "multicontext": {
      "type": "remote",
      "url": "http://127.0.0.1:4317/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}
```

If OpenCode is on another machine (not recommended — localhost default), set `MULTICONTEXT_HOST=0.0.0.0` and update URL accordingly, understanding the credential is then network-visible. Prefer SSH tunnel.

**Other hosts:** Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`) and Claude Code (`~/.claude.json` or `.mcp.json`) use `mcpServers` with `command`/`args` for stdio; for Streamable HTTP they also support remote config (check host docs). The Desktop `接続情報をコピー` button copies just the endpoint for those formats.

## Example External Workflow

```javascript
// 1. list agents, pick one
const { agents } = await mcp.callTool('multicontext_list_agents', {});
const defaultAgent = agents[0].id;

// 2. create workspace with 4 chats
const { id: wsId } = await mcp.callTool('multicontext_create_workspace', {
  name: 'My Research',
  system_prompt: 'You are a helpful assistant.',
  default_agent_id: defaultAgent,
  initial_chat_count: 4
});

// 3. configure per-chat prompts
await mcp.callTool('multicontext_update_chat', { workspace_id: wsId, chat_id: chatIds[0], developer_prompt: 'You are the critic.' });

// 4. broadcast
await mcp.callTool('multicontext_broadcast', { workspace_id: wsId, prompt: 'Summarize the paper.' });

// 5. wait
await mcp.callTool('multicontext_wait_until_settled', { workspace_id: wsId, timeout_seconds: 60 });

// 6. inspect results (isolated)
for (const cid of chatIds) {
  const { messages } = await mcp.callTool('multicontext_get_chat_messages', { workspace_id: wsId, chat_id: cid, limit: 20 });
}

// 7. compile (only when SETTLED, does not mutate histories)
await mcp.callTool('multicontext_compile', { workspace_id: wsId });
```

Direct send to one chat:

```javascript
await mcp.callTool('multicontext_send', { workspace_id: wsId, chat_id: chatIds[1], prompt: 'Only you should see this.' });
```

## Tool List (19)

| Tool | Input | Notes |
|------|-------|-------|
| `multicontext_list_workspaces` | — | runtimeState, active/total counts |
| `multicontext_get_workspace` | `workspace_id`, `include_messages?`, `message_limit` | bounded, no secrets |
| `multicontext_create_workspace` | `name?`, `system_prompt?`, `default_agent_id?`, `initial_chat_count? 0-10` | |
| `multicontext_update_workspace` | `workspace_id`, `name?`, `system_prompt?`, `default_agent_id?`, `compile_agent_id?`, `compile_prompt?` | |
| `multicontext_delete_workspace` | `workspace_id` | destructive |
| `multicontext_list_agents` | — | id,name,provider |
| `multicontext_add_chat` | `workspace_id`, `name?`, `developer_prompt?`, `agent_id?` | |
| `multicontext_update_chat` | `workspace_id`, `chat_id`, `name?`, `developer_prompt?`, `agent_id?`, `active?`, `can_inspect_others?`, `can_send_others?` | |
| `multicontext_delete_chat` | `workspace_id`, `chat_id` | |
| `multicontext_broadcast` | `workspace_id`, `prompt 1-100k` | validates before queue |
| `multicontext_send` | `workspace_id`, `chat_id`, `prompt` | ordinary user |
| `multicontext_stop_workspace` | `workspace_id` | |
| `multicontext_stop_chat` | `workspace_id`, `chat_id` | |
| `multicontext_retry_chat` | `workspace_id`, `chat_id` | |
| `multicontext_get_runtime_status` | `workspace_id?` | separated layers |
| `multicontext_compile` | `workspace_id` | only SETTLED, shared guard |
| `multicontext_wait_until_settled` | `workspace_id`, `timeout_seconds 1-300`, `poll_interval_ms 100-5000` | returns SETTLED/BLOCKED/TIMEOUT |
| `multicontext_get_chat_messages` | `workspace_id`, `chat_id`, `limit 1-200`, `since?` | bounded |
| `multicontext_get_compile_result` | `workspace_id` | |

Resources via `multicontext://workspaces` etc are not required; tools are primary.

## SETTLED & Compile Semantics

- `SETTLED` is purely mechanical: no active generation, no queued work, no blocked member. It does **not** assert semantic agreement.
- `multicontext_wait_until_settled` polls `store.runtimeState` every `poll_interval_ms`, returns on `SETTLED`/`BLOCKED`/timeout/disappearance, honors client cancellation (abort), bounded 1-300s, no busy-loop, no state mutation.
- `multicontext_compile` only when `SETTLED`, uses shared `compilingWorkspaces` guard (REST and MCP share the same `Set`), collects bounded recent visible records from active chats, calls `client.runAgent` with `workspace.compilePrompt`, stores result in `workspace.lastCompile`, never writes into member histories.

## Agent Selection Behavior

- Source of truth is LibreChat `GET /api/agents/v1/responses/models`.
- Effective: `member.agentId ?? workspace.defaultAgentId ?? (exactly-one-agent ? thatId : require_selection)`. Explicit IDs are never silently overwritten.
- **Single agent:** auto-selected for new workspaces/members and for compile fallback.
- **Multiple agents, no default:** `AGENT_SELECTION_REQUIRED` (400, Japanese message) before any queue mutation; broadcast validates all active members before enqueue, direct validates target, cross-chat `send-to-chat` validates all targets before any enqueue (avoid partial delivery).
- **Stale/deleted:** non-empty ID is validated against current discovery; if not found → `AGENT_NOT_AVAILABLE` actionable, UI shows `利用不可`.
- **Compile:** `compileAgentId ?? workspace.defaultAgentId ?? singleAgent ?? error` (not first active member).

## Security Model

- Loopback by default, `Host`/`Origin` validation via `@modelcontextprotocol/node` guards.
- **Non-loopback invariant:** MCP shares the main Node listener (`http://127.0.0.1:<port>/mcp`, `mcpHost` does not create a separate listener). Startup enforces: if MCP is enabled and either `MULTICONTEXT_HOST` or `MULTICONTEXT_MCP_HOST` is non-loopback (`0.0.0.0`, `::`, `192.168.x.x` ...), a non-empty `MULTICONTEXT_MCP_TOKEN` is required — otherwise `validateMcpConfig()` fails fast with an actionable error (`MCP enabled with non-loopback bind requires MULTICONTEXT_MCP_TOKEN`). Loopback binds (`127.0.0.1`, `localhost`, `::1`, `::ffff:127.0.0.1`) with no token remain allowed for local development. MCP disabled bypasses the check.
- MCP token is distinct, stored in Keychain, never returned from `runtime_status`, `/api/mcp/status`, or logs. `GET /api/mcp/token` would be 404; `get_opencode_config` returns token only for explicit clipboard copy.
- LibreChat key, provider credentials, `conversationId`/`current`/`lastRun` are never serialized to MCP or REST public views.
- Tool `send-to-chat` still validates `allowCrossChatSend` etc.; private `inspect_chat` respects `allowCrossChatInspect`.
- If you must bind beyond localhost (`MULTICONTEXT_HOST=0.0.0.0`), set a strong token and understand the credential is network-visible; prefer SSH tunnel.
