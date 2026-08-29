#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod health;
mod process;
mod runtime;

use config::{DesktopConfig, Ownership, ServiceState, ServiceStatus};
use health::HealthKind::*;
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
    let line = format!("[{}] {}\n", now_secs(), marker);
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
    let model = cfg.model_path.clone().ok_or("モデルファイルが未設定です")?;
    let template = cfg.template_path.clone().ok_or("チャットテンプレートが未設定です")?;
    let (host, port) = runtime::parse_host_port(&cfg.model_url);
    let args: Vec<String> = vec![
        "-m".into(),
        model,
        "--jinja".into(),
        "--chat-template-file".into(),
        template,
        "--chat-template-kwargs".into(),
        r#"{"reasoning_effort":"low"}"#.into(),
        "--host".into(),
        host,
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        "8192".into(),
        "--parallel".into(),
        "4".into(),
    ];
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
    envs.insert("MULTICONTEXT_PORT".into(), cfg.multicontent_port.to_string());
    envs.insert(
        "MULTICONTEXT_DATA_FILE".into(),
        data_file.to_string_lossy().to_string(),
    );
    envs.insert("MULTICONTEXT_LIBRECHAT_MODE".into(), "native".into());
    envs.insert("LIBRECHAT_BASE_URL".into(), cfg.librechat_url.clone());
    // Pass through LibreChat credentials/proxy from the app environment.
    // The desktop app does NOT own these secrets; it only forwards whatever
    // the user's environment already provides (e.g. via `launchctl setenv`).
    for key in [
        "LIBRECHAT_API_KEY",
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
    trace(&app, &format!("startup begin: manage_model={} manage_librechat={} port={}", cfg.manage_model, cfg.manage_librechat, cfg.multicontent_port));
    cfg.validate()?;
    let node = resolve_node(&state)
        .ok_or("Node.js が見つかりません。設定で Node のパスを指定してください。")?;
    trace(&app, &format!("node resolved: {}", node));

    let client = health::client();

    // ---- MODEL ----
    emit_service(&app, &state, "モデル", ServiceState::Checking, "確認中...", false);
    if health::probe(Model, &cfg.model_url, &client).await {
        emit_service(&app, &state, "モデル", ServiceState::Ready, "接続済み (外部)", true);
    } else if cfg.manage_model {
        trace(&app, "model not healthy, manage_model=true -> starting");
        emit_service(
            &app,
            &state,
            "モデル",
            ServiceState::Starting,
            "起動中...",
            false,
        );
        if let Err(e) = start_model(&app, &state, &cfg) {
            emit_service(&app, &state, "モデル", ServiceState::Error, &e, false);
            return Err(e);
        }
        if health::wait_ready(Model, &cfg.model_url, 40, Duration::from_secs(2)).await {
            emit_service(&app, &state, "モデル", ServiceState::Ready, "起動済み (管理)", true);
        } else {
            emit_service(
                &app,
                &state,
                "モデル",
                ServiceState::Error,
                "モデルの起動がタイムアウトしました",
                false,
            );
            return Err("モデルの起動がタイムアウトしました".to_string());
        }
    } else {
        emit_service(
            &app,
            &state,
            "モデル",
            ServiceState::Error,
            "未起動 — 外部で起動してください",
            false,
        );
        trace(&app, "model not healthy and manage_model=false -> error");
        return Err("モデルが起動していません (管理無効)".to_string());
    }

    // ---- LIBRECHAT ----
    emit_service(&app, &state, "LibreChat", ServiceState::Checking, "確認中...", false);
    if health::probe(LibreChat, &cfg.librechat_url, &client).await {
        emit_service(&app, &state, "LibreChat", ServiceState::Ready, "接続済み (外部)", true);
    } else if cfg.manage_librechat {
        trace(&app, "librechat not healthy, manage_librechat=true -> starting");
        emit_service(
            &app,
            &state,
            "LibreChat",
            ServiceState::Starting,
            "起動中...",
            false,
        );
        if let Err(e) = start_librechat(&app, &state, &cfg, &node) {
            emit_service(&app, &state, "LibreChat", ServiceState::Error, &e, false);
            return Err(e);
        }
        if health::wait_ready(LibreChat, &cfg.librechat_url, 30, Duration::from_secs(2)).await {
            emit_service(&app, &state, "LibreChat", ServiceState::Ready, "起動済み (管理)", true);
        } else {
            emit_service(
                &app,
                &state,
                "LibreChat",
                ServiceState::Error,
                "LibreChat の起動がタイムアウトしました",
                false,
            );
            return Err("LibreChat の起動がタイムアウトしました".to_string());
        }
    } else {
        emit_service(
            &app,
            &state,
            "LibreChat",
            ServiceState::Error,
            "未起動 — 外部で起動してください",
            false,
        );
        trace(&app, "librechat not healthy and manage_librechat=false -> error");
        return Err("LibreChat が起動していません (管理無効)".to_string());
    }

    // ---- MULTICONTEXT ----
    let mc_url = format!("http://127.0.0.1:{}", cfg.multicontent_port);
    emit_service(&app, &state, "MultiContext", ServiceState::Checking, "確認中...", false);
    if health::is_listening(&client, &mc_url).await {
        emit_service(&app, &state, "MultiContext", ServiceState::Ready, "起動済み (外部)", true);
    } else {
        emit_service(
            &app,
            &state,
            "MultiContext",
            ServiceState::Starting,
            "起動中...",
            false,
        );
        if let Err(e) = start_multicontext(&app, &state, &cfg, &node) {
            trace(&app, &format!("start_multicontext failed: {}", e));
            emit_service(&app, &state, "MultiContext", ServiceState::Error, &e, false);
            return Err(e);
        }
        trace(&app, "start_multicontext ok, waiting for listen");
        if health::wait_listening(&mc_url, 20, Duration::from_secs(2)).await {
            emit_service(&app, &state, "MultiContext", ServiceState::Ready, "起動済み", true);
        } else {
            emit_service(
                &app,
                &state,
                "MultiContext",
                ServiceState::Error,
                "MultiContext の起動がタイムアウトしました",
                false,
            );
            return Err("MultiContext の起動がタイムアウトしました".to_string());
        }
    }

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
            check_health,
            get_services,
            get_logs,
            open_logs_dir,
            validate_executable,
            pick_path,
            frontend_ready,
            startup,
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
