# MultiContext Chat

Parallel isolated local LLM chats with per-chat personas, queued cross-chat messaging, built-in source search and calculation, and optional response synthesis. The primary workflow connects directly to a local model server: no LibreChat account, API key, or saved Agent is required. LibreChat integration is optional legacy compatibility, not a prerequisite.

> Release status: the registration-free direct-local path has recorded native
> macOS, MCP, Compile, test, and packaged-bundle checkpoints; these are not a
> fresh GUI certification of every subsequent commit. See the dated/scope-specific
> [desktop audit](docs/DESKTOP_RESEARCH_AUDIT.md) and
> [research experiments](docs/RESEARCH_METHOD_AB.md). Do not distribute
> the unsigned local DMG; Developer ID signing, notarization/stapling, and a
> final pass on that signed artifact are still required for general distribution.

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

## What the research experiments establish

MultiContext is an orchestration and evidence-recording tool, not a mathematical
verifier. Real local GPT-OSS Navier–Stokes trials completed searches, calculations,
peer inspection and continuation, but broad persona reviews repeatedly accepted
incorrect identities. A successful tool call or agreement between chats does not
make their conclusion correct. No Millennium problem solution or novel regularity
result has been established by these experiments.

Bounded single-claim checks recovered some counterexamples and elementary bounds;
even these sometimes omitted requested derivations or contradicted intermediate
steps. A review-present/no-review comparison did not demonstrate an accuracy
benefit from attaching reviews. The results suggest a workflow to test, not a
proven winning strategy:

1. Define one obligation, its assumptions and a concrete acceptance check.
2. Let a member work independently with search/calculation before peer exposure.
3. Inspect the actual tool inputs/results and every inference, not just the verdict.
4. Record rejected or incomplete claims with source message IDs; revise explicitly.
5. Share only with those assessments attached. Treat Compile as unverified synthesis.

Native peer inspection carries the target's latest eight review records and an
omitted-record count. Reviews are self-reported assessments, not proof certificates;
retrieve missing evidence before relying on a truncated handoff. For all successes,
failures, controls and limitations, see the [experiment record](docs/RESEARCH_METHOD_AB.md).

## Quick start — local model, no registration

Start a tool-capable local model server on `http://127.0.0.1:8080`, then run:

```bash
npm run check
npm start
```

Open `http://127.0.0.1:4317` and select the discovered model. Personas are configured
in MultiContext chats. Search requires internet access but no search-service account;
retrieved metadata is not proof. See [local setup](docs/LOCAL_BACKEND.md).

The Node server defaults to `local`, `http://127.0.0.1:8080`, and
`./data/local-state.json`. Environment variables are needed only to override those
values or explicitly select the optional `librechat` backend.

The separate local state file avoids reusing LibreChat conversation identifiers.
New desktop configurations default to local mode; existing saved desktop settings
are preserved and may still select LibreChat. Change the backend in desktop settings
to use local mode; do not rename legacy state files to force a migration.

## Optional LibreChat modes

### `native` (default)

Designed for gpt-oss when exact role separation and LibreChat-owned conversation context are required. Apply the small, idempotent host patch:

```bash
node scripts/patch-librechat.mjs /path/to/LibreChat
```

Native mode also includes keyless Web and scholarly source search. See
[built-in search](docs/BUILTIN_SEARCH.md) for privacy, availability and validation.

Rebuild LibreChat, then set:

```env
MULTICONTEXT_LIBRECHAT_MODE=native
```

Native mode stores one stable LibreChat conversation id per MultiContext member and continues it with `previous_response_id`. Request-level cross-chat tools are exposed to the model but executed by MultiContext, not LibreChat. After a model `function_call`, the native continuation re-sends the answered `function_call` item followed by its `function_call_output`, together with `previous_response_id` and the same tool definitions. It does **not** replay `system`, `developer`, `user`, or local history. This explicit tool round trip is required because LibreChat persistence alone does not retain enough structured tool-call state for gpt-oss to ground a dangling `function_call_output`. Native mode fails fast if the patched conversation-id header is absent. See `docs/GPT_OSS.md`.

### `compat`

Works with stock LibreChat. MultiContext owns each member's bounded history, sends `store:false`, and replays that member history on every turn. The request boundary still contains separate `system` and `developer` items, but stock LibreChat may normalize them internally.

## Optional legacy LibreChat setup

```bash
cp .env.example .env
# configure LIBRECHAT_BASE_URL and LIBRECHAT_API_KEY
npm run check
npm start
```

Open `http://127.0.0.1:4317`.

Optional legacy LibreChat container path (the direct-local adapter intentionally
accepts only a host loopback endpoint):

```bash
docker compose up --build
```

If LibreChat must call the generated cross-chat Actions, configure `MULTICONTEXT_PUBLIC_URL` to a URL reachable **from the LibreChat process/container**.

## Desktop (macOS)

Native launcher you can double-click from Finder/Dock. It bundles the
MultiContext Node server (no dependency on the Git checkout) and can start
your local model backend for you. LibreChat is optional compatibility, not a
desktop prerequisite.

```bash
npm run desktop:dev   # Tauri dev
npm run desktop:build # production MultiContext.app
npm run verify:bundle # bundled server + MCP smoke verification
npm run verify:desktop # packaged UI/resource freshness verification
npm run verify:release  # complete macOS release-candidate verification
open src-tauri/target/release/bundle/macos/MultiContext.app
```

### Product usage and recovery

1. Launch `MultiContext.app`; it reuses a healthy local model server or starts
   the configured managed model service.
2. On first launch, use the local backend and configure your model server URL,
   or the managed llama-server and model paths. No LibreChat registration,
   connection key, or saved LibreChat Agent is required. Existing installations
   preserve their backend selection; switch it to local in Settings if needed.
3. Choose an Agent explicitly in safe mode, or use `auto_first` when first-Agent
   selection is acceptable. Safe mode rejects an unconfigured broadcast with
   `AGENT_SELECTION_REQUIRED`.
4. When creating a workspace, choose 1–8 initial chats (2 is recommended for
   parallel comparison). Assign an Agent to each chat before broadcasting.
5. On service/workspace refresh failure, use `Retry` / `再確認`. The last saved
   view remains visible, retry progress is shown, and privacy-safe diagnostics
   can be copied from the AI Stack status dialog.
6. Archive/delete only inactive workspaces. Deletion requires typing the exact
   workspace name; state saves retain a `.bak` recovery copy.
7. Before a major configuration change, use `バックアップを作成` in Desktop
   Settings to create a timestamped state snapshot. A settled workspace can be
   copied with `複製`; its history and settings are preserved, while active
   queues and provider conversation IDs are reset.

The product provides isolated chat contexts with per-chat FIFO queues and
parallel execution. Compile is allowed only at `SETTLED` and does not write
back into member histories. REST and external MCP share the same application
operation layer, while LibreChat Agent tool use remains a separate path.

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

After the first launch, just open `MultiContext.app` — it detects a healthy
local model server or starts the configured managed model and opens the UI
once ready. Configure the model URL or llama-server, GPT-OSS model, and chat
template in Settings. `Retry` performs a fresh readiness attempt.

Only if you select the optional LibreChat backend do you need its directory
and Remote Agents connection key. That key is validated against the Remote
Agents API and saved in macOS Keychain, never shown back or stored in
`config.json` or logs. An empty key field preserves the stored key; deletion
requires explicit `保存済みキーを削除`. See `docs/DESKTOP.md` for first-run setup (external vs managed
services, Keychain credential storage, logs at
`~/Library/Logs/com.unjuno.multicontext/`, and Gatekeeper notes for unsigned
builds).

## Runtime states

- `RUNNING` — at least one member is generating.
- `PENDING` — queued work is waiting and can run.
- `BLOCKED` — a model/tool request failed; the prompt was returned to the front of that member FIFO and requires explicit Retry.
- `SETTLED` — all active member queues are empty and no member is running or blocked.

Stop aborts active requests and clears pending work. An interrupted process does not silently lose an in-flight prompt: startup recovery requeues it.

Completed or blocked workspaces can be archived without deleting their history. Archived workspaces are hidden from the default list and can be found through the `アーカイブ済み` filter and restored. Running or queued workspaces cannot be archived, so active work is never hidden accidentally.

## Cross-chat tools

Each member exposes an OpenAPI Action URL. The Action contains:

- `list_chats()`
- `inspect_chat(target, query, limit)`
- `send_to_chat(targets, prompt)` where `targets` contains one or two chat ids/exact names

In the default direct-local path, MultiContext exposes and executes these tools.
The optional LibreChat path also has its own Agent tool configuration. Message
interpretation and tool-use policy remain prompt/model responsibilities.

## Compile

Compile is available only when the workspace is `SETTLED` and only runs when the user presses Compile. `compilePrompt` is editable. The compiler receives bounded recent visible records from active chats and returns one compressed response. Scheduler-observed tool calls are also stored as a deterministic, attributable audit beside the model-written synthesis and included when the report is copied or downloaded. This records execution, not correctness or proof. No compile output is written into member histories.

## Research-method A/B

`npm run experiment:research-ab` compares independent parallel personas with a
staged source → revision → independent-audit flywheel on the same bounded task and
local model. Reverse the arm order with
`MULTICONTEXT_RESEARCH_AB_ORDER=BA`. See
[`docs/RESEARCH_METHOD_AB.md`](docs/RESEARCH_METHOD_AB.md) for the acceptance
criteria, retained evidence, observed results, and limitations.

## Validation

`npm run check` runs syntax checks and Node tests covering context/queue isolation, FIFO + cross-member concurrency, failure requeue and explicit Retry, persisted in-flight recovery, Stop stale-result suppression, native/compat request shaping, LibreChat health/agent discovery, cross-chat Action delivery, HTTP runtime state/Compile gating, and patch idempotency.

Run `npm run smoke` against a real LibreChat deployment. Set `MULTICONTEXT_SMOKE_AGENT_ID` to include real generation and native thread-continuation checks.

For the long-running MCP user flow, set `MULTICONTEXT_STRESS_URL` and
`MULTICONTEXT_STRESS_TOKEN`, then run `npm run stress`. The stress flow is
skipped by ordinary `npm test` unless both values are explicitly supplied, so
it cannot accidentally send work to a running local instance.

## License

MIT. LibreChat remains a separate MIT-licensed upstream dependency.
