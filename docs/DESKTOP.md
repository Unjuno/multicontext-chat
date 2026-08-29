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
- `multicontent_port: 4317`
- `manage_librechat: false`, `manage_model: false` (reuse external)

If required fields are missing, the startup screen explains what is missing.

**LibreChat API key (no Terminal needed):** on the Settings screen, enter the
key in `LibreChat API Key` and press `保存`. It is stored in the macOS
**Keychain** (`security` generic password, service `com.unjuno.multicontext`)
and is **never** written to `config.json` or any log. On startup, Desktop reads
it from the Keychain and injects it only into the managed MultiContext child
process environment (`LIBRECHAT_API_KEY`). This makes a Finder-double-click
launch fully self-contained. As a fallback, Desktop also forwards
`LIBRECHAT_API_KEY` / proxy vars from its own environment if set via
`launchctl setenv`. LibreChat continues to own provider credentials.

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

`desktop-startup.html` polls `check_all_services` every 2s, shows `CHECKING/STARTING/READY/ERROR` for each service, and auto-navigates to `http://127.0.0.1:4317` when all `Ready`.

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

- **External (default):** If LibreChat/model already healthy at configured URLs, Desktop reuses them (`ownership: EXTERNAL`) and does **not** terminate them on quit.
- **Managed:** If `manage_librechat` or `manage_model` true and health fails, Desktop attempts to start the service and marks `STARTED_BY_MULTICONTEXT`, then stops it on quit (SIGTERM to the whole process group). MultiContext Node is always managed if not already running: Desktop resolves `server_root` via `app.path().resource_dir()/multicontext` (production) or the repo checkout (dev), then runs `find_node()` + `node src/server.js` from the bundled resources.

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
- **MultiContext port occupied:** Change `multicontent_port` in config or stop the conflicting service (`lsof -i :4317`).
- **Node not found (Finder):** Desktop checks `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/run/current-system/sw/bin/node`, `which node`, and `PATH`. Set absolute path in config if needed.
- **Blank window:** Check logs, ensure `public/desktop-startup.html` exists and `frontendDist` is `../public`.
- **Infinite spinner:** Startup uses bounded retries (15 × 2s = 30s) with real `reqwest` health checks, not fixed sleep.

## Security

- No API keys stored in `config.json` or `localStorage`. LibreChat owns provider credentials.
- Logs redact `sk-`, `bearer`, `token`, `password`, `api_key`.
- `MULTICONTEXT_PUBLIC_URL` origin handling unchanged (no broad Host trust).

## Window

- Title `MultiContext`, `1280×820`, `min 760×600`, resizable, centered. Last size not yet persisted (optional future).
