# MultiContext Desktop

Tauri 2 launcher for the existing MultiContext web application. The desktop app is a thin shell that checks local services, starts the Node server it manages, and loads the existing UI in a native WebView.

## Architecture

```
MultiContext Desktop (Tauri)
  ├─ startup UI (desktop-startup.html)
  ├─ health checks (LibreChat, model, MultiContext)
  ├─ process ownership (EXTERNAL vs STARTED_BY_MULTICONTEXT)
  └─ WebView -> http://127.0.0.1:4317 (existing HTML/CSS/JS)
        |
        v
   MultiContext Node server (src/server.js)
        |
        v
   LibreChat (Remote Agents API)
        |
        v
   gpt-oss / llama.cpp (http://127.0.0.1:8080)
```

Existing `npm start` continues to work without Tauri.

## Requirements

- macOS 11+
- Node >=22 (`which node` must be resolvable from Finder; checked at `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/run/current-system/sw/bin/node`)
- Rust 1.77+ (`rustc --version`)
- Tauri CLI `2.x` (`npx tauri --version` or `@tauri-apps/cli`)
- LibreChat checkout (if managed) and/or running `http://127.0.0.1:3080`
- Model backend at `http://127.0.0.1:8080/v1` (OpenAI-compatible base; or external), template `scripts/llama/gpt-oss-chat-template.fixed.jinja`

## First-time Setup

The desktop app is self-contained: it bundles the MultiContext Node server into
`MultiContext.app/Contents/Resources/multicontext/` and starts it from there, so
it does **not** depend on the Git checkout remaining at a development path.

**Simplest path (external services already running):**

1. Start LibreChat and your model backend (gpt-oss / llama.cpp) yourself, OR
2. Let Desktop manage them: open Settings (⚙) on the startup screen, set
   `LibreChat: 管理` + its checkout path, `モデル: 管理` + `llama-server`,
   model `.gguf`, and chat template, then `保存` → `開始`.

After the first save, config lives at
`~/Library/Application Support/com.unjuno.multicontext/config.json`
(created via Tauri `app_config_dir`). Defaults:

- `librechat_url: http://127.0.0.1:3080`
- `model_url: http://127.0.0.1:8080/v1`
- `multicontext_port: 4317` (canonical; the old misspelling `multicontent_port` is still accepted as a backward-compatible alias)
- `manage_librechat: true`, `manage_model: true` (new installs default to managed GPT-OSS + LibreChat; healthy external services are still reused first and never killed)

If required fields are missing, the startup screen explains what is missing.

**LibreChat 接続キー (no Terminal needed):** on the Settings screen, the
`LibreChat 接続` section shows the current connection state
(`要設定` / `接続済み` / `接続キーを確認してください` / `LibreChat に接続できません`)
and an input for the key. The key is a **LibreChat Remote Agents API key** and is
validated against the Remote Agents API (`GET /api/agents/v1/responses/models`
with `Authorization: Bearer <key>`), not the normal LibreChat browser/user JWT.
Enter the key and press `保存`, or fill it together with the other paths and
press `保存して開始` — the key is saved to Keychain first, then config, then
startup. It is stored in the macOS **Keychain** (`security` generic password,
service `com.unjuno.multicontext`) and is **never** written to `config.json` or
any log, and the actual value is never shown back in the UI after saving. An
empty key field preserves the stored key; deletion requires the explicit
`保存済みキーを削除` action. On startup, Desktop reads it from the Keychain and
injects it only into the managed MultiContext child process environment
(`LIBRECHAT_API_KEY`). This makes a Finder-double-click launch fully
self-contained. As a fallback, Desktop also forwards `LIBRECHAT_API_KEY` / proxy
vars from its own environment if set via `launchctl setenv`. LibreChat continues
to own provider credentials.

If you prefer to run the backends manually, the original commands still apply:

```
node scripts/patch-librechat.mjs /path/to/LibreChat
# rebuild LibreChat, set OPENAI_REVERSE_PROXY=http://127.0.0.1:8080/v1

llama-server -m /path/to/gpt-oss-20b-MXFP4.gguf --jinja \
  --chat-template-file scripts/llama/gpt-oss-chat-template.fixed.jinja \
  --chat-template-kwargs '{"reasoning_effort":"low"}' --host 127.0.0.1 --port 8080
```

## Development

```bash
npm run desktop:dev   # tauri dev (loads desktop-startup.html, then http://127.0.0.1:4317)
# or
npm start             # just the Node server at 4317
npx tauri dev --help
```

`desktop-startup.html` runs the `startup` command and listens to streamed
`startup-progress` events (each tagged with an `attempt_id` generation token).
It shows user-facing states
(`確認中` / `起動中` / `接続中` / `準備完了` / `要設定` / `エラー`) for each service and
auto-navigates to `http://127.0.0.1:4317` exactly once, when every service is
truly `READY`. MultiContext is only considered `READY` after its own
`GET /api/health` returns `ok === true` — the body is parsed even on HTTP 503
so a structured `{ok:false, librechat:{ok:false}}` yields a precise credential
vs. offline vs. wrong-service message. `Retry` always starts a fresh attempt
(`state.statuses = {}` + new `attemptId`; delayed events from a previous attempt
are ignored). The `connection_status` command reports LibreChat reachability/auth
against the Remote Agents API without exposing the key.

## Production Build

```bash
npm run desktop:check  # cargo check
npm run check          # 59 tests
npm run desktop:build  # tauri build
```

Artifact:
```
src-tauri/target/release/bundle/macos/MultiContext.app
# optional
src-tauri/target/release/bundle/dmg/MultiContext_0.2.0_aarch64.dmg
```

Launch:
```
open "src-tauri/target/release/bundle/macos/MultiContext.app"
# or via Finder double-click
```

Gatekeeper (unsigned local build):
```
xattr -d com.apple.quarantine "src-tauri/target/release/bundle/macos/MultiContext.app"
# or System Settings -> Privacy -> Open Anyway
```

## Configuration (external vs managed)

- **External (reused first):** If LibreChat/model already healthy at configured URLs, Desktop reuses them (`ownership: EXTERNAL`) and does **not** terminate them on quit.
- **Managed (new-install default `true`, “start if absent”):** If `manage_librechat` or `manage_model` true and health fails, Desktop attempts to start the service and marks `STARTED_BY_MULTICONTEXT`, then stops it on quit (SIGTERM to the whole process group). Existing saved configs keep their stored `manage_*` values. MultiContext Node is always managed if not already running: Desktop resolves `server_root` via `app.path().resource_dir()/multicontext` (production) or the repo checkout (dev), then runs `find_node()` + `node src/server.js` from the bundled resources.

Readiness:
- **Model:** considered healthy only when its OpenAI-compatible `/v1/models` returns a `{"data":[...]}` shape (a bare 200 HTML page is not treated as ready).
- **LibreChat:** considered healthy when its `/health` returns 2xx.
- **MultiContext:** considered `READY` only when `GET /api/health` returns 2xx **and** `ok === true`. A listening-but-unusable server (503, wrong service on the port, missing/wrong LibreChat key) is reported as `エラー`, not `READY`.

Managed launch profile (GPT-OSS / llama.cpp): the fixed serving profile
(`reasoning_effort=low`, `ctx-size=8192`, `parallel=4`) lives in
`src-tauri/src/launch.rs` as `GptOssLaunchProfile` / `build_model_args`, so the
tuning is decoupled from the startup code and is the default for the managed
model path.

Validation:
- `validate_executable` checks `librechat_path`, `llama_path`, `model_path` exist and are executable.
- `DesktopConfig::validate` checks URLs and port.

## Logs

- Tauri logs: `~/Library/Logs/com.unjuno.multicontext/` (via `app_log_dir`)
  including `desktop.log`, `multicontext.log`, `model.log`, `librechat.log`.
- MultiContext managed: `~/Library/Logs/com.unjuno.multicontext/multicontext.log` (redacted: any line containing `sk-` or `bearer` is `[REDACTED]`)

UI: `ログを表示` -> `open_logs_dir` (Finder) or `get_logs` (in-app).

## Troubleshooting

- **LibreChat not found:** Check `librechat_url` and that LibreChat was started via `npm run backend` in its checkout.
- **Model not reachable:** Check `model_url` and that `llama-server` was started with the fixed template (`ps aux | grep llama` should show `--chat-template-file ...fixed.jinja`).
- **MultiContext port occupied:** Change `multicontext_port` in config or stop the conflicting service (`lsof -i :4317`). If another service is already answering on the port, MultiContext reports `エラー` rather than a false `READY`.
- **Node not found (Finder):** Desktop checks `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/run/current-system/sw/bin/node`, `which node`, and `PATH`. Set absolute path in config if needed.
- **Blank window:** Check logs, ensure `public/desktop-startup.html` exists and `frontendDist` is `../public`.
- **Infinite spinner:** Startup uses bounded retries (15 × 2s = 30s) with real `reqwest` health checks, not fixed sleep.

## Security

- No API keys stored in `config.json` or `localStorage`. LibreChat owns provider credentials.
- Logs redact `sk-`, `bearer`, `token`, `password`, `api_key`.
- `MULTICONTEXT_PUBLIC_URL` origin handling unchanged (no broad Host trust).

## Window

- Title `MultiContext`, `1280×820`, `min 760×600`, resizable, centered. Last size not yet persisted (optional future).
