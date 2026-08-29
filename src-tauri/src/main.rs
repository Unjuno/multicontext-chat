#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod health;
mod keychain;
mod launch;
mod process;
mod runtime;

use config::{DesktopConfig, Ownership, ServiceState, ServiceStatus};
use health::HealthKind::*;
use health::{AuthStatus, McHealth};
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
) {
    let started = state.children.children.lock().unwrap().contains_key(name);
    let ownership = ownership_from(started, healthy);
    let status = ServiceStatus {
        name: name.to_string(),
        state: sstate,
        message: msg.to_string(),
        ownership,
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
    keychain::set_key(&key)
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
                            if low.contains("sk-") || low.contains("bearer") || low.contains("api_key") {
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
    let entry = cwd.join("src").join("server.js");
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

/// Build a concise, user-facing error message for the not-ready MultiContext
/// stack. The stored key is never shown; we only report presence/connection.
fn connection_error_message(librechat_ok: Option<bool>, detail: &str) -> String {
    if keychain::has_key() {
        if librechat_ok == Some(false) {
            "接続キーを確認してください（LibreChat 接続に失敗しました）".to_string()
        } else if librechat_ok == Some(true) {
            format!("LibreChat は接続できましたが、MultiContext が利用できません: {}", detail)
        } else {
            format!("MultiContext が利用できません: {}", detail)
        }
    } else {
        "LibreChat 接続キーを設定してください".to_string()
    }
}

async fn ensure_model(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
) -> Result<(), String> {
    emit_service(app, state, "モデル", ServiceState::Checking, "確認中...", false);
    if health::is_model_healthy(client, &cfg.model_url).await {
        emit_service(app, state, "モデル", ServiceState::Ready, "準備完了", true);
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
        );
        return Err("モデルが起動していません（管理無効）".to_string());
    }
    // Retry safety: drop any stale/failed tracked child before spawning anew.
    process::reap_dead(&state.children);
    process::terminate(&state.children, "モデル");
    emit_service(app, state, "モデル", ServiceState::Starting, "起動中...", false);
    if let Err(e) = start_model(app, state, cfg) {
        emit_service(app, state, "モデル", ServiceState::Error, &e, false);
        return Err(e);
    }
    if health::wait_model_ready(&cfg.model_url, 40, Duration::from_secs(2)).await {
        emit_service(app, state, "モデル", ServiceState::Ready, "準備完了 (管理)", true);
        Ok(())
    } else {
        // Clean up the managed child we just spawned; never leave it orphaned.
        process::terminate(&state.children, "モデル");
        let msg = "GPT-OSS (llama-server) の起動に失敗しました。ログを確認してください。".to_string();
        emit_service(app, state, "モデル", ServiceState::Error, &msg, false);
        Err("モデルの起動がタイムアウトしました".to_string())
    }
}

async fn ensure_librechat(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
    node: &str,
) -> Result<(), String> {
    emit_service(app, state, "LibreChat", ServiceState::Checking, "接続中...", false);
    if health::probe(LibreChat, &cfg.librechat_url, &client).await {
        emit_service(app, state, "LibreChat", ServiceState::Ready, "準備完了", true);
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
        );
        return Err("LibreChat が起動していません（管理無効）".to_string());
    }
    process::reap_dead(&state.children);
    process::terminate(&state.children, "LibreChat");
    emit_service(app, state, "LibreChat", ServiceState::Starting, "接続中...", false);
    if let Err(e) = start_librechat(app, state, cfg, node) {
        emit_service(app, state, "LibreChat", ServiceState::Error, &e, false);
        return Err(e);
    }
    if health::wait_ready(LibreChat, &cfg.librechat_url, 30, Duration::from_secs(2)).await {
        emit_service(app, state, "LibreChat", ServiceState::Ready, "準備完了 (管理)", true);
        Ok(())
    } else {
        process::terminate(&state.children, "LibreChat");
        let msg = "LibreChat の起動に失敗しました。ログを確認してください。".to_string();
        emit_service(app, state, "LibreChat", ServiceState::Error, &msg, false);
        Err("LibreChat の起動がタイムアウトしました".to_string())
    }
}

async fn ensure_multicontext(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    cfg: &DesktopConfig,
    client: &reqwest::Client,
    node: &str,
) -> Result<(), String> {
    let mc_url = format!("http://127.0.0.1:{}", cfg.multicontext_port);
    emit_service(app, state, "MultiContext", ServiceState::Checking, "確認中...", false);
    match health::multicontext_health(client, &mc_url).await {
        McHealth::Ready => {
            emit_service(app, state, "MultiContext", ServiceState::Ready, "準備完了", true);
            return Ok(());
        }
        McHealth::Unhealthy { librechat_ok, detail } => {
            // Already running but not usable (e.g. missing/wrong key). Do NOT
            // restart onto the occupied port; surface the real cause instead.
            let msg = connection_error_message(librechat_ok, &detail);
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false);
            return Err(msg);
        }
        McHealth::Unreachable => {}
    }
    process::reap_dead(&state.children);
    process::terminate(&state.children, "MultiContext");
    emit_service(app, state, "MultiContext", ServiceState::Starting, "起動中...", false);
    if let Err(e) = start_multicontext(app, state, cfg, node) {
        emit_service(app, state, "MultiContext", ServiceState::Error, &e, false);
        return Err(e);
    }
    if !health::wait_listening(&mc_url, 20, Duration::from_secs(2)).await {
        process::terminate(&state.children, "MultiContext");
        let msg = "MultiContext の起動がタイムアウトしました。ログを確認してください。".to_string();
        emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false);
        return Err(msg);
    }
    match health::multicontext_health(client, &mc_url).await {
        McHealth::Ready => {
            emit_service(app, state, "MultiContext", ServiceState::Ready, "準備完了", true);
            Ok(())
        }
        McHealth::Unhealthy { librechat_ok, detail } => {
            process::terminate(&state.children, "MultiContext");
            let msg = connection_error_message(librechat_ok, &detail);
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false);
            Err(msg)
        }
        McHealth::Unreachable => {
            process::terminate(&state.children, "MultiContext");
            let msg = "MultiContext が応答しません。ログを確認してください。".to_string();
            emit_service(app, state, "MultiContext", ServiceState::Error, &msg, false);
            Err(msg)
        }
    }
}

#[tauri::command]
async fn startup(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<ServiceStatus>, String> {
    let cfg = { state.config.lock().unwrap().clone() };
    // Guard against concurrent/duplicate startup runs (e.g. auto-start on load
    // plus an explicit 開始/再試行 click) which would double-launch services.
    let _guard = {
        let mut starting = state.starting.lock().unwrap();
        if *starting {
            return Ok(state.services.lock().unwrap().values().cloned().collect());
        }
        *starting = true;
        StartGuard { flag: &state.starting }
    };
    trace(&app, &format!("startup begin: manage_model={} manage_librechat={} port={}", cfg.manage_model, cfg.manage_librechat, cfg.multicontext_port));
    cfg.validate()?;
    let node = resolve_node(&state)
        .ok_or("Node.js が見つかりません。設定で Node のパスを指定してください。")?;
    trace(&app, &format!("node resolved: {}", node));

    let client = health::client();

    ensure_model(&app, &state, &cfg, &client).await?;

    ensure_librechat(&app, &state, &cfg, &client, &node).await?;

    ensure_multicontext(&app, &state, &cfg, &client, &node).await?;

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
            has_api_key,
            check_health,
            get_services,
            get_logs,
            open_logs_dir,
            validate_executable,
            pick_path,
            frontend_ready,
            startup,
            connection_status,
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
        };
        s.state = ServiceState::Starting;
        assert_eq!(s.state, ServiceState::Starting);
        s.state = ServiceState::Ready;
        assert_eq!(s.state, ServiceState::Ready);
        s.state = ServiceState::Error;
        assert_eq!(s.state, ServiceState::Error);
    }
}
