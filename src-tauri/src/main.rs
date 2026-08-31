#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod health;
mod keychain;
mod launch;
mod process;
mod runtime;

use config::{DesktopConfig, Ownership, ServiceState, ServiceStatus};
use health::HealthKind::*;
use health::{AuthStatus, McFailureKind, McHealth};
use process::Managed;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

struct AppState {
    config: Mutex<DesktopConfig>,
    services: Mutex<HashMap<String, ServiceStatus>>,
    children: Managed,
    dev_cwd: PathBuf,
    starting: Mutex<bool>,
    attempt: Mutex<u64>,
}

/// Resets the `starting` flag when the startup command returns (success, error,
/// or early return), so a later startup attempt is not permanently blocked.
struct StartGuard<'a> {
    flag: &'a Mutex<bool>,
}
impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        *self.flag.lock().unwrap() = false;
    }
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.join("config.json")
}

fn log_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_log_dir().unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn trace(app: &tauri::AppHandle, msg: &str) {
    let dir = log_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("desktop.log");
    let line = format!("[{}] {}\n", now_secs(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Ownership rule: a service we started stays ours even if a later health
/// probe succeeds; an already-running service we did not start is External.
pub fn ownership_from(started: bool, healthy: bool) -> Option<Ownership> {
    if started {
        Some(Ownership::StartedByMulticontext)
    } else if healthy {
        Some(Ownership::External)
    } else {
        None
    }
}

fn emit_service(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    name: &str,
    sstate: ServiceState,
    msg: &str,
    healthy: bool,
    attempt_id: u64,
) {
    let started = state.children.children.lock().unwrap().contains_key(name);
    let ownership = ownership_from(started, healthy);
    let status = ServiceStatus {
        name: name.to_string(),
        state: sstate,
        message: msg.to_string(),
        ownership,
        attempt_id,
    };
    let _ = app.emit("startup-progress", status.clone());
    state.services.lock().unwrap().insert(name.to_string(), status);
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>, app: tauri::AppHandle) -> DesktopConfig {
    let path = config_path(&app);
    if path.exists() {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(disk) = serde_json::from_str::<DesktopConfig>(&data) {
                *state.config.lock().unwrap() = disk.clone();
                return disk;
            }
        }
    }
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
    config: DesktopConfig,
) -> Result<(), String> {
    config.validate()?;
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    // An empty field must NOT delete a stored key; only `delete_api_key` does.
    // This prevents a stray empty "保存" click from wiping the user's credential.
    if key.is_empty() {
        return Ok(());
    }
    keychain::set_key(&key)
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    keychain::delete_key()
}

#[tauri::command]
fn has_api_key() -> bool {
    keychain::has_key()
}

#[tauri::command]
async fn check_health(url: String, kind: String) -> bool {
    let k = match kind.as_str() {
        "librechat" => LibreChat,
        "model" => Model,
        _ => MultiContext,
    };
    health::probe(k, &url, &health::client()).await
}

#[tauri::command]
fn get_services(state: tauri::State<AppState>) -> Vec<ServiceStatus> {
    state.services.lock().unwrap().values().cloned().collect()
}

#[tauri::command]
async fn runtime_status(state: tauri::State<'_, AppState>) -> Result<Vec<ServiceStatus>, String> {
    let cfg = state.config.lock().unwrap().clone();
    let client = health::client();
    let attempt_id = *state.attempt.lock().unwrap();
    let mut out = Vec::with_capacity(3);

    // GPT-OSS: strict model health (data/models non-empty), not just process exists
    let model_healthy = health::is_model_healthy(&client, &cfg.model_url).await;
    let model_started = state.children.children.lock().unwrap().contains_key("モデル");
    let model_ownership = ownership_from(model_started, model_healthy);
    let (model_state, model_msg) = if model_healthy {
        (ServiceState::Ready, "準備完了".to_string())
    } else {
        // Distinguish checking vs error via stored startup state if available
        let stored = state.services.lock().unwrap().get("モデル").cloned();
        match stored.map(|s| s.state) {
            Some(ServiceState::Starting) => (ServiceState::Starting, "起動中...".to_string()),
            Some(ServiceState::Checking) => (ServiceState::Checking, "確認中...".to_string()),
            _ => (ServiceState::Error, "GPT-OSS を起動できません".to_string()),
        }
    };
    out.push(ServiceStatus {
        name: "モデル".to_string(),
        state: model_state,
        message: model_msg,
        ownership: model_ownership,
        attempt_id,
    });

    // LibreChat: Remote Agents key validation (never expose key)
    let librechat_started = state.children.children.lock().unwrap().contains_key("LibreChat");
    let (librechat_state, librechat_msg, librechat_healthy) = match keychain::get_key() {
        Some(key) if !key.is_empty() => match health::librechat_auth(&cfg.librechat_url, &key).await {
            AuthStatus::Ok => (ServiceState::Ready, "接続済み".to_string(), true),
            AuthStatus::Forbidden => (ServiceState::Error, "接続キーを確認してください".to_string(), false),
            AuthStatus::Unreachable => (ServiceState::Error, "LibreChat に接続できません".to_string(), false),
        },
        _ => {
            let client2 = health::client();
            let reachable = health::probe(LibreChat, &cfg.librechat_url, &client2).await;
            if reachable {
                (ServiceState::Ready, "準備完了".to_string(), true)
            } else {
                (ServiceState::NeedsSetup, "要設定".to_string(), false)
            }
        }
    };
    let librechat_ownership = ownership_from(librechat_started, librechat_healthy);
    out.push(ServiceStatus {
        name: "LibreChat".to_string(),
        state: librechat_state,
        message: librechat_msg,
        ownership: librechat_ownership,
        attempt_id,
    });

    // MultiContext: strict ok===true, body parsed even on 503
    let mc_url = format!("http://127.0.0.1:{}", cfg.multicontext_port);
    let mc_started = state.children.children.lock().unwrap().contains_key("MultiContext");
    let (mc_state, mc_msg, mc_healthy) = match health::multicontext_health(&client, &mc_url).await {
        McHealth::Ready => (ServiceState::Ready, "準備完了".to_string(), true),
        McHealth::Unhealthy { kind, librechat_ok: _, detail } => {
            let msg = connection_error_message(kind, None, &detail);
            // Map WrongService/Generic to Error, LibreChat already handled
            (ServiceState::Error, msg, false)
        }
        McHealth::Unreachable => (ServiceState::Error, "MultiContext が応答しません".to_string(), false),
    };
    let mc_ownership = ownership_from(mc_started, mc_healthy);
    out.push(ServiceStatus {
        name: "MultiContext".to_string(),
        state: mc_state,
        message: mc_msg,
        ownership: mc_ownership,
        attempt_id,
    });

    // Keep services cache reasonably current without overwriting attempt_id semantics
    {
        let mut cache = state.services.lock().unwrap();
        for s in &out {
            cache.insert(s.name.clone(), s.clone());
        }
    }

    Ok(out)
}

#[tauri::command]
fn validate_executable(path: String) -> bool {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&p) {
            return meta.permissions().mode() & 0o111 != 0;
        }
    }
    true
}

#[tauri::command]
fn pick_path(kind: String) -> Option<String> {
    let script = match kind.as_str() {
        "dir" => "choose folder",
        _ => "choose file",
    };
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!("POSIX path of ({})", script))
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

#[tauri::command]
fn get_logs(app: tauri::AppHandle) -> String {
    let dir = log_dir(&app);
    if !dir.exists() {
        return "ログディレクトリが見つかりません".to_string();
    }
    let mut out = String::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|s| s == "log").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let redacted = content
                        .lines()
                        .map(|l| {
                            let low = l.to_lowercase();
                            if low.contains("sk-") || low.contains("bearer") || low.contains("api_key") || low.contains("mcp_token") || low.contains("multicontext_mcp") {
                                "[REDACTED LINE]".to_string()
                            } else {
                                l.to_string()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    out.push_str(&format!("--- {} ---\n{}\n", path.display(), redacted));
                }
            }
        }
    }
    if out.is_empty() {
        "ログはまだありません".to_string()
    } else {
        out
    }
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, marker: String) {
    let dir = log_dir(&app);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("frontend.log");
    // Defensively redact any secret-bearing text before writing to logs.
    let safe = process::redact(&marker);
    let line = format!("[{}] {}\n", now_secs(), safe);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

#[tauri::command]
fn open_logs_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = log_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resolve_node(state: &tauri::State<AppState>) -> Option<String> {
    let cfg = state.config.lock().unwrap().clone();
    cfg.node_path.or_else(runtime::find_node)
}

fn start_model(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    cfg: &DesktopConfig,
) -> Result<(), String> {
    let llama = cfg.llama_path.clone().ok_or("llama-server が未設定です")?;
    let model = cfg.model_path.clone().ok_or("GPT-OSS モデルファイルが未設定です")?;
    let template = cfg.template_path.clone().ok_or("チャットテンプレートが未設定です")?;
    let (host, port) = runtime::parse_host_port(&cfg.model_url);
    let profile = launch::GptOssProfile::default();
    let args = launch::build_model_args(&profile, &model, &template, &host, port);
    let cwd = PathBuf::from("/");
    let envs: HashMap<String, String> = HashMap::new();
    let log = log_dir(app).join("model.log");
    let (pid, child) = process::spawn_service(&llama, &args, &cwd, &envs, &log)?;
    state
        .children
        .children
        .lock()
        .unwrap()
        .insert("モデル".into(), (pid, child));
    Ok(())
}

fn start_librechat(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    cfg: &DesktopConfig,
    node: &str,
) -> Result<(), String> {
    let lc = cfg.librechat_path.clone().ok_or("LibreChat パスが未設定です")?;
    let cwd = PathBuf::from(&lc);
    let args: Vec<String> = vec!["api/server/index.js".into()];
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("NODE_ENV".into(), "production".into());
    if let Some(parent) = PathBuf::from(node).parent() {
        let existing = std::env::var("PATH").unwrap_or_default();
        envs.insert("PATH".into(), format!("{}:{}", parent.display(), existing));
    }
    let log = log_dir(app).join("librechat.log");
    let (pid, child) = process::spawn_service(node, &args, &cwd, &envs, &log)?;
    state
        .children
        .children
        .lock()
        .unwrap()
        .insert("LibreChat".into(), (pid, child));
    Ok(())
}

fn start_multicontext(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    cfg: &DesktopConfig,
    node: &str,
) -> Result<(), String> {
    let cwd = runtime::server_root(app, &state.dev_cwd);
    let entry = runtime::server_entry(&cwd, &state.dev_cwd);
    if !entry.exists() {
        return Err(format!(
            "MultiContext サーバーが見つかりません: {} (リソースが正しくバンドルされていません)",
            entry.display()
        ));
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let data_file = data_dir.join("state.json");
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("MULTICONTEXT_PORT".into(), cfg.multicontext_port.to_string());
    envs.insert(
        "MULTICONTEXT_DATA_FILE".into(),
        data_file.to_string_lossy().to_string(),
    );
    envs.insert("MULTICONTEXT_LIBRECHAT_MODE".into(), "native".into());
    envs.insert("LIBRECHAT_BASE_URL".into(), cfg.librechat_url.clone());
    // LibreChat API key: prefer the Keychain value the user saved in Settings
    // (preferred, since it survives Finder launches without `launchctl`), then
    // fall back to the app environment (e.g. `launchctl setenv`). The desktop
    // app never stores the secret in config.json and never logs it.
    let keychain_key = keychain::get_key();
    if let Some(v) = &keychain_key {
        if !v.is_empty() {
            envs.insert("LIBRECHAT_API_KEY".into(), v.clone());
        }
    }
    // Pass through LibreChat credentials/proxy from the app environment.
    for key in [
        "LIBRECHAT_API_KEY_B",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    ] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                envs.insert(key.to_string(), v);
            }
        }
    }
    // Env var can override the keychain value if explicitly provided.
    if keychain_key.is_none() {
        if let Ok(v) = std::env::var("LIBRECHAT_API_KEY") {
            if !v.is_empty() {
                envs.insert("LIBRECHAT_API_KEY".into(), v);
            }
        }
    }
    // MCP control token: generate on first enable, inject into child
    if cfg.mcp_enabled {
        let token = keychain::get_mcp_token();
        let token = match token {
            Some(t) if !t.is_empty() => Some(t),
            _ => {
                let gen = keychain::generate_mcp_token();
                let _ = keychain::set_mcp_token(&gen);
                Some(gen)
            }
        };
        if let Some(t) = token {
            envs.insert("MULTICONTEXT_MCP_TOKEN".into(), t);
        }
        envs.insert("MULTICONTEXT_MCP_ENABLED".into(), "true".into());
    } else {
        envs.insert("MULTICONTEXT_MCP_ENABLED".into(), "false".into());
    }
    if let Some(parent) = PathBuf::from(node).parent() {
        let existing = std::env::var("PATH").unwrap_or_default();
        envs.insert("PATH".into(), format!("{}:{}", parent.display(), existing));
    }
    let log = log_dir(app).join("multicontext.log");
    let args: Vec<String> = vec![entry.to_string_lossy().to_string()];
    let (pid, child) = process::spawn_service(node, &args, &cwd, &envs, &log)?;
    state
        .children
        .children
        .lock()
        .unwrap()
        .insert("MultiContext".into(), (pid, child));
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ConnectionStatus {
    pub has_key: bool,
    pub librechat_reachable: bool,
    pub auth_ok: bool,
}

/// Report the user-facing LibreChat connection state without exposing the key.
#[tauri::command]
async fn connection_status(state: tauri::State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let cfg = state.config.lock().unwrap().clone();
    let status = match keychain::get_key() {
        Some(key) if !key.is_empty() => {
            let auth = health::librechat_auth(&cfg.librechat_url, &key).await;
            ConnectionStatus {
                has_key: true,
                librechat_reachable: !matches!(auth, AuthStatus::Unreachable),
                auth_ok: matches!(auth, AuthStatus::Ok),
            }
        }
        _ => {
            let client = health::client();
            let reachable = health::probe(LibreChat, &cfg.librechat_url, &client).await;
            ConnectionStatus {
                has_key: false,
                librechat_reachable: reachable,
                auth_ok: false,
            }
        }
    };
    Ok(status)
}

#[derive(serde::Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub has_token: bool,
    pub endpoint: String,
}

#[tauri::command]
fn get_mcp_status(state: tauri::State<AppState>) -> McpStatus {
    let cfg = state.config.lock().unwrap().clone();
    let endpoint = format!("http://127.0.0.1:{}/mcp", cfg.multicontext_port);
    McpStatus { enabled: cfg.mcp_enabled, has_token: keychain::has_mcp_token(), endpoint }
}

fn restart_owned_multicontext(app: &tauri::AppHandle, state: &tauri::State<AppState>) -> Result<bool, String> {
    let is_owned = state.children.children.lock().unwrap().contains_key("MultiContext");
    if !is_owned {
        return Ok(false);
    }
    process::terminate(&state.children, "MultiContext");
    std::thread::sleep(std::time::Duration::from_millis(300));
    let cfg = state.config.lock().unwrap().clone();
    let node = resolve_node(state).ok_or("Node.js が見つかりません")?;
    start_multicontext(app, state, &cfg, &node)?;
    // Brief wait for port to become listening; health polling will confirm readiness separately
    std::thread::sleep(std::time::Duration::from_millis(500));
    Ok(true)
}

#[tauri::command]
fn set_mcp_enabled(state: tauri::State<AppState>, app: tauri::AppHandle, enabled: bool) -> Result<McpStatus, String> {
    let mut cfg = state.config.lock().unwrap().clone();
    cfg.mcp_enabled = enabled;
    // Persist
    let path = config_path(&app);
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let data = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = cfg.clone();
    // If enabling and no token, generate one
    if enabled && !keychain::has_mcp_token() {
        let tok = keychain::generate_mcp_token();
        let _ = keychain::set_mcp_token(&tok);
    }
    // Restart owned MultiContext to pick up new enabled/token
    let restarted = restart_owned_multicontext(&app, &state)?;
    if !restarted && state.children.children.lock().unwrap().contains_key("MultiContext") == false {
        // External service - inform caller via log, UI will show external notice
        trace(&app, &format!("set_mcp_enabled external: restart required for token/config change"));
    }
    Ok(McpStatus { enabled: cfg.mcp_enabled, has_token: keychain::has_mcp_token(), endpoint: format!("http://127.0.0.1:{}/mcp", cfg.multicontext_port) })
}

#[tauri::command]
fn generate_mcp_token(state: tauri::State<AppState>, app: tauri::AppHandle) -> Result<String, String> {
    let tok = keychain::generate_mcp_token();
    keychain::set_mcp_token(&tok)?;
    let restarted = restart_owned_multicontext(&app, &state)?;
    if !restarted {
        trace(&app, "generate_mcp_token external: restart required");
    }
    Ok(tok)
}

#[tauri::command]
fn get_mcp_token() -> Result<String, String> {
    keychain::get_mcp_token().ok_or_else(|| "MCPトークンが設定されていません".to_string())
}

#[tauri::command]
fn delete_mcp_token() -> Result<(), String> {
    keychain::delete_mcp_token()
}

#[tauri::command]
fn get_opencode_config(state: tauri::State<AppState>) -> Result<String, String> {
    let cfg = state.config.lock().unwrap().clone();
    let token = keychain::get_mcp_token().unwrap_or_default();
    if token.is_empty() { return Err("MCPトークンが未設定です。先に有効化してトークンを生成してください。".to_string()); }
    let endpoint = format!("http://127.0.0.1:{}/mcp", cfg.multicontext_port);
    // OpenCode remote MCP format as per 2025-12 docs
    let json = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "multicontext": {
                "type": "remote",
                "url": endpoint,
                "enabled": true,
                "headers": {
                    "Authorization": format!("Bearer {}", token)
                }
            }
        }
    });
    Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn get_mcp_endpoint(state: tauri::State<AppState>) -> String {
    let cfg = state.config.lock().unwrap().clone();
    format!("http://127.0.0.1:{}/mcp", cfg.multicontext_port)
}

/// Build a concise, user-facing error message for the not-ready MultiContext
/// stack. The stored key is never shown; we only report presence/connection.
/// Categories map to the user-facing messages required by the spec:
/// * no stored key            -> "LibreChat 接続キーを設定してください"
/// * Remote Agents key rejected -> "LibreChat 接続キーを確認してください"
/// * wrong service on port    -> "MultiContext ポートが別のサービスで使用されています"
fn connection_error_message(kind: McFailureKind, _librechat_ok: Option<bool>, detail: &str) -> String {
    match kind {
        McFailureKind::WrongService => {
            "MultiContext ポートが別のサービスで使用されています".to_string()
        }
        McFailureKind::LibreChat => {
            if keychain::has_key() {
                // `detail` already carries a safe, redacted user message.
                detail.to_string()
            } else {
                "LibreChat 接続キーを設定してください".to_string()
            }
        }
        McFailureKind::Generic => {
            if keychain::has_key() {
                format!("MultiContext が利用できません: {}", detail)
            } else {
                "LibreChat 接続キーを設定してください".to_string()
            }
        }
    }
}

async fn ensure_model(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
    attempt_id: u64,
) -> Result<(), String> {
    emit_service(app, state, "モデル", ServiceState::Checking, "確認中...", false, attempt_id);
    if health::is_model_healthy(client, &cfg.model_url).await {
        emit_service(app, state, "モデル", ServiceState::Ready, "準備完了", true, attempt_id);
        return Ok(());
    }
    if !cfg.manage_model {
        emit_service(
            app,
            state,
            "モデル",
            ServiceState::NeedsSetup,
            "未起動 — 外部で起動してください",
            false,
            attempt_id,
        );
        return Err("モデルが起動していません（管理無効）".to_string());
    }
    // Retry safety: drop any stale/failed tracked child before spawning anew.
    process::reap_dead(&state.children);
    process::terminate(&state.children, "モデル");
    emit_service(app, state, "モデル", ServiceState::Starting, "起動中...", false, attempt_id);
    if let Err(e) = start_model(app, state, cfg) {
        emit_service(app, state, "モデル", ServiceState::Error, &e, false, attempt_id);
        return Err(e);
    }
    if health::wait_model_ready(&cfg.model_url, 40, Duration::from_secs(2)).await {
        emit_service(app, state, "モデル", ServiceState::Ready, "準備完了 (管理)", true, attempt_id);
        Ok(())
    } else {
        // Clean up the managed child we just spawned; never leave it orphaned.
        process::terminate(&state.children, "モデル");
        let msg = "GPT-OSS を起動できません。ログを確認してください。".to_string();
        emit_service(app, state, "モデル", ServiceState::Error, &msg, false, attempt_id);
        Err("モデルの起動がタイムアウトしました".to_string())
    }
}

async fn ensure_librechat(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
    node: &str,
    attempt_id: u64,
) -> Result<(), String> {
    emit_service(app, state, "LibreChat", ServiceState::Checking, "接続中...", false, attempt_id);
    if health::probe(LibreChat, &cfg.librechat_url, &client).await {
        emit_service(app, state, "LibreChat", ServiceState::Ready, "準備完了", true, attempt_id);
        return Ok(());
    }
    if !cfg.manage_librechat {
        emit_service(
            app,
            state,
            "LibreChat",
            ServiceState::NeedsSetup,
            "未起動 — 外部で起動してください",
            false,
            attempt_id,
        );
        return Err("LibreChat が起動していません（管理無効）".to_string());
    }
    process::reap_dead(&state.children);
    process::terminate(&state.children, "LibreChat");
    emit_service(app, state, "LibreChat", ServiceState::Starting, "接続中...", false, attempt_id);
    if let Err(e) = start_librechat(app, state, cfg, node) {
        emit_service(app, state, "LibreChat", ServiceState::Error, &e, false, attempt_id);
        return Err(e);
    }
    if health::wait_ready(LibreChat, &cfg.librechat_url, 30, Duration::from_secs(2)).await {
        emit_service(app, state, "LibreChat", ServiceState::Ready, "準備完了 (管理)", true, attempt_id);
        Ok(())
    } else {
        process::terminate(&state.children, "LibreChat");
        let msg = "LibreChat を起動できません。ログを確認してください。".to_string();
        emit_service(app, state, "LibreChat", ServiceState::Error, &msg, false, attempt_id);
        Err("LibreChat の起動がタイムアウトしました".to_string())
    }
}

async fn ensure_multicontext(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
    node: &str,
    attempt_id: u64,
) -> Result<(), String> {
    let mc_url = format!("http://127.0.0.1:{}", cfg.multicontext_port);
    emit_service(app, state, "MultiContext", ServiceState::Checking, "確認中...", false, attempt_id);
    match health::multicontext_health(client, &mc_url).await {
        McHealth::Ready => {
            emit_service(app, state, "MultiContext", ServiceState::Ready, "準備完了", true, attempt_id);
            return Ok(());
        }
        McHealth::Unhealthy { kind, librechat_ok, detail } => {
            // Already running but not usable (e.g. missing/wrong key). Do NOT
            // restart onto the occupied port; surface the real cause instead.
            let msg = connection_error_message(kind, librechat_ok, &detail);
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false, attempt_id);
            return Err(msg);
        }
        McHealth::Unreachable => {}
    }
    process::reap_dead(&state.children);
    process::terminate(&state.children, "MultiContext");
    emit_service(app, state, "MultiContext", ServiceState::Starting, "起動中...", false, attempt_id);
    if let Err(e) = start_multicontext(app, state, cfg, node) {
        emit_service(app, state, "MultiContext", ServiceState::Error, &e, false, attempt_id);
        return Err(e);
    }
    if !health::wait_listening(&mc_url, 20, Duration::from_secs(2)).await {
        process::terminate(&state.children, "MultiContext");
        let msg = "MultiContext の起動がタイムアウトしました。ログを確認してください。".to_string();
        emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false, attempt_id);
        return Err(msg);
    }
    match health::multicontext_health(client, &mc_url).await {
        McHealth::Ready => {
            emit_service(app, state, "MultiContext", ServiceState::Ready, "準備完了", true, attempt_id);
            Ok(())
        }
        McHealth::Unhealthy { kind, librechat_ok, detail } => {
            process::terminate(&state.children, "MultiContext");
            let msg = connection_error_message(kind, librechat_ok, &detail);
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false, attempt_id);
            Err(msg)
        }
        McHealth::Unreachable => {
            process::terminate(&state.children, "MultiContext");
            let msg = "MultiContext が応答しません。ログを確認してください。".to_string();
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false, attempt_id);
            Err(msg)
        }
    }
}

#[tauri::command]
async fn startup(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    attempt_id: Option<u64>,
) -> Result<Vec<ServiceStatus>, String> {
    let cfg = { state.config.lock().unwrap().clone() };
    // Guard against concurrent/duplicate startup runs and capture a run-local
    // immutable attempt token. The token is NOT taken from global state on each
    // emit; a late attempt 2 call that is rejected must not mutate attempt 1's
    // in-flight events.
    let run_attempt: u64;
    let _guard: StartGuard<'_>;
    {
        let mut starting = state.starting.lock().unwrap();
        if *starting {
            return Ok(state.services.lock().unwrap().values().cloned().collect());
        }
        *starting = true;
        let mut attempt_lock = state.attempt.lock().unwrap();
        let id = match attempt_id {
            Some(v) => v,
            None => attempt_lock.wrapping_add(1),
        };
        *attempt_lock = id;
        run_attempt = id;
        _guard = StartGuard { flag: &state.starting };
    }
    trace(&app, &format!("startup begin: manage_model={} manage_librechat={} port={}", cfg.manage_model, cfg.manage_librechat, cfg.multicontext_port));
    cfg.validate()?;
    let node = resolve_node(&state)
        .ok_or("Node.js が見つかりません。設定で Node のパスを指定してください。")?;
    trace(&app, &format!("node resolved: {}", node));

    let client = health::client();

    ensure_model(&app, &state, &cfg, &client, run_attempt).await?;

    ensure_librechat(&app, &state, &cfg, &client, &node, run_attempt).await?;

    ensure_multicontext(&app, &state, &cfg, &client, &node, run_attempt).await?;

    Ok(state.services.lock().unwrap().values().cloned().collect())
}

fn main() {
    let dev_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            config: Mutex::new(DesktopConfig::default()),
            services: Mutex::new(HashMap::new()),
            children: Managed::new(),
            dev_cwd,
            starting: Mutex::new(false),
            attempt: Mutex::new(0),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = std::fs::create_dir_all(log_dir(&handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    process::stop_all(&state.children);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            save_api_key,
            delete_api_key,
            has_api_key,
            check_health,
            get_services,
            runtime_status,
            get_logs,
            open_logs_dir,
            validate_executable,
            pick_path,
            frontend_ready,
            startup,
            connection_status,
            get_mcp_status,
            set_mcp_enabled,
            generate_mcp_token,
            get_mcp_token,
            delete_mcp_token,
            get_opencode_config,
            get_mcp_endpoint,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit { .. }
            ) {
                if let Some(state) = app.try_state::<AppState>() {
                    process::stop_all(&state.children);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ownership_external_not_stopped() {
        assert!(matches!(
            ownership_from(false, true),
            Some(Ownership::External)
        ));
    }

    #[test]
    fn test_ownership_started_should_stop() {
        assert!(matches!(
            ownership_from(true, true),
            Some(Ownership::StartedByMulticontext)
        ));
        // A service we started must remain ours even if a later probe is unhealthy.
        assert!(matches!(
            ownership_from(true, false),
            Some(Ownership::StartedByMulticontext)
        ));
    }

    #[test]
    fn test_ownership_unhealthy_unknown() {
        assert_eq!(ownership_from(false, false), None);
    }

    #[test]
    fn test_service_state_transitions() {
        let mut s = ServiceStatus {
            name: "Test".into(),
            state: ServiceState::Checking,
            message: "".into(),
            ownership: None,
            attempt_id: 0,
        };
        s.state = ServiceState::Starting;
        assert_eq!(s.state, ServiceState::Starting);
        s.state = ServiceState::Ready;
        assert_eq!(s.state, ServiceState::Ready);
        s.state = ServiceState::Error;
        assert_eq!(s.state, ServiceState::Error);
    }
}
