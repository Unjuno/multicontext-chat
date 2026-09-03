# MultiContext Chat

Parallel isolated LLM chats with per-chat prompts/tools, queued cross-chat messaging, and optional response compression. LibreChat supplies the Agent runtime, model/provider integrations, Web Search, MCP, code execution, knowledge, and other existing tools.

## Core behavior

- One human prompt is broadcast to every active chat.
- Each chat keeps an independent context and an independent FIFO input queue.
- Different chats run in parallel; one chat processes only one queued prompt at a time.
- Workspace `system` prompt is shared and editable.
- Each chat has an editable `developer` prompt.
- Human broadcasts and cross-chat queued prompts are sent as normal `user` input.
- Chats do not automatically receive another chat's history or tool results.
- Optional tools let a chat list peers, inspect selected peer messages, or queue a prompt to one or two peers.
- The application does not decide what an input means or when a model should use those tools. Prompt/model behavior owns that decision.
- `SETTLED` is a runtime state: no active generation, queued work, or blocked failed turn remains.
- Compile is manual. Its result is user-facing only and is not injected back into member contexts.

## LibreChat modes

### `native` (default)

Designed for gpt-oss when exact role separation and LibreChat-owned conversation context are required. Apply the small, idempotent host patch:

```bash
node scripts/patch-librechat.mjs /path/to/LibreChat
```

Rebuild LibreChat, then set:

```env
MULTICONTEXT_LIBRECHAT_MODE=native
```

Native mode stores one stable LibreChat conversation id per MultiContext member and continues it with `previous_response_id`. Request-level cross-chat tools are exposed to the model but executed by MultiContext, not LibreChat. After a model `function_call`, the native continuation re-sends the answered `function_call` item followed by its `function_call_output`, together with `previous_response_id` and the same tool definitions. It does **not** replay `system`, `developer`, `user`, or local history. This explicit tool round trip is required because LibreChat persistence alone does not retain enough structured tool-call state for gpt-oss to ground a dangling `function_call_output`. Native mode fails fast if the patched conversation-id header is absent. See `docs/GPT_OSS.md`.

### `compat`

Works with stock LibreChat. MultiContext owns each member's bounded history, sends `store:false`, and replays that member history on every turn. The request boundary still contains separate `system` and `developer` items, but stock LibreChat may normalize them internally.

## Quick start

```bash
cp .env.example .env
# configure LIBRECHAT_BASE_URL and LIBRECHAT_API_KEY
npm run check
npm start
```

Open `http://127.0.0.1:4317`.

Docker:

```bash
docker compose up --build
```

If LibreChat must call the generated cross-chat Actions, configure `MULTICONTEXT_PUBLIC_URL` to a URL reachable **from the LibreChat process/container**.

## Desktop (macOS)

Native launcher you can double-click from Finder/Dock. It bundles the
MultiContext Node server (no dependency on the Git checkout) and can start
LibreChat and your model backend for you.

```bash
npm run desktop:dev   # Tauri dev
npm run desktop:build # production MultiContext.app
open src-tauri/target/release/bundle/macos/MultiContext.app
```

## External Control MCP

MultiContext exposes itself as an MCP server so external clients (OpenCode, Cursor, Claude Code) can operate workspaces programmatically. This is **not** LibreChat Agent MCP.

- Endpoint: `http://127.0.0.1:4317/mcp` (Streamable HTTP, loopback by default)
- Auth: `MULTICONTEXT_MCP_TOKEN` (distinct from LibreChat key, stored in macOS Keychain when using Desktop)
- OpenCode config: Desktop Settings → `外部連携 — MCP Server` → `OpenCode設定をコピー` generates a ready `opencode.json` remote entry (see `docs/MCP.md`).

```bash
# enable and copy config via Desktop UI, or manually:
MULTICONTEXT_MCP_TOKEN=$(openssl rand -hex 32) npm start
```

See `docs/MCP.md` for tool list, agent selection, SETTLED/Compile semantics, and security.

After the first launch, just open `MultiContext.app` — it detects healthy
external GPT-OSS/LibreChat or starts managed ones (new installs default to
managed) and opens the existing UI automatically once everything is ready. On
first run, open Settings and set your LibreChat directory, llama-server, GPT-OSS
model, chat template, and the LibreChat Remote Agents connection key (validated
against the Remote Agents API, not normal user auth — saved once in macOS
Keychain via the `LibreChat 接続` section — no Terminal, no `config.json`, empty
field preserves the stored key, deletion requires explicit `保存済みキーを削除`,
and the key is never shown back). `保存して開始` saves a newly entered key
together with config in one step; `Retry` always performs a fresh readiness
attempt. See `docs/DESKTOP.md` for first-run setup (external vs managed
services, Keychain credential storage, logs at
`~/Library/Logs/com.unjuno.multicontext/`, and Gatekeeper notes for unsigned
builds).

## Runtime states

- `RUNNING` — at least one member is generating.
- `PENDING` — queued work is waiting and can run.
- `BLOCKED` — a model/tool request failed; the prompt was returned to the front of that member FIFO and requires explicit Retry.
- `SETTLED` — all active member queues are empty and no member is running or blocked.

Stop aborts active requests and clears pending work. An interrupted process does not silently lose an in-flight prompt: startup recovery requeues it.

## Cross-chat tools

Each member exposes an OpenAPI Action URL. The Action contains:

- `list_chats()`
- `inspect_chat(target, query, limit)`
- `send_to_chat(targets, prompt)` where `targets` contains one or two chat ids/exact names

Tool availability is controlled in MultiContext and in LibreChat Agent configuration. Message interpretation and tool-use policy remain prompt/model responsibilities.

## Compile

Compile is available only when the workspace is `SETTLED` and only runs when the user presses Compile. `compilePrompt` is editable. The compiler receives bounded recent visible records from active chats and returns one compressed response. No compile output is written into member histories.

## Validation

`npm run check` runs syntax checks and Node tests covering context/queue isolation, FIFO + cross-member concurrency, failure requeue and explicit Retry, persisted in-flight recovery, Stop stale-result suppression, native/compat request shaping, LibreChat health/agent discovery, cross-chat Action delivery, HTTP runtime state/Compile gating, and patch idempotency.

Run `npm run smoke` against a real LibreChat deployment. Set `MULTICONTEXT_SMOKE_AGENT_ID` to include real generation and native thread-continuation checks.

## License

MIT. LibreChat remains a separate MIT-licensed upstream dependency.
