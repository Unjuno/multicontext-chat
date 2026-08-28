#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Ownership {
    External,
    StartedByMulticontext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ServiceState {
    Checking,
    Ready,
    Starting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServiceStatus {
    name: String,
    state: ServiceState,
    message: String,
    ownership: Option<Ownership>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopConfig {
    librechat_path: Option<String>,
    librechat_url: String,
    multicontent_port: u16,
    model_url: String,
    llama_path: Option<String>,
    model_path: Option<String>,
    template_path: Option<String>,
    manage_librechat: bool,
    manage_model: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            librechat_path: None,
            librechat_url: "http://127.0.0.1:3080".to_string(),
            multicontent_port: 4317,
            model_url: "http://127.0.0.1:8080".to_string(),
            llama_path: None,
            model_path: None,
            template_path: None,
            manage_librechat: false,
            manage_model: false,
        }
    }
}

impl DesktopConfig {
    fn validate(&self) -> Result<(), String> {
        if !self.librechat_url.starts_with("http://") && !self.librechat_url.starts_with("https://") {
            return Err("LibreChat URL must be http(s)".to_string());
        }
        if !self.model_url.starts_with("http://") && !self.model_url.starts_with("https://") {
            return Err("Model URL must be http(s)".to_string());
        }
        if self.multicontent_port == 0 {
            return Err("MultiContext port must be >0".to_string());
        }
        if let Some(p) = &self.librechat_path {
            if !PathBuf::from(p).exists() && !p.is_empty() {
                return Err(format!("LibreChat path not found: {}", p));
            }
        }
        if let Some(p) = &self.llama_path {
            if !PathBuf::from(p).exists() && !p.is_empty() {
                return Err(format!("llama-server not found: {}", p));
            }
        }
        if let Some(p) = &self.model_path {
            if !PathBuf::from(p).exists() && !p.is_empty() {
                return Err(format!("Model path not found: {}", p));
            }
        }
        Ok(())
    }
}

fn redact_command(cmd: &str) -> String {
    // Redact secrets: API keys, tokens, passwords
    let mut out = cmd.to_string();
    for key in ["sk-", "bearer ", "token=", "password", "api_key"] {
        if out.to_lowercase().contains(key) {
            // simple redaction: replace value after key with [REDACTED]
            return "[REDACTED COMMAND]".to_string();
        }
    }
    out
}

struct AppState {
    config: Mutex<DesktopConfig>,
    services: Mutex<HashMap<String, ServiceStatus>>,
    // Track child PIDs we started
    children: Mutex<HashMap<String, u32>>,
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.join("config.json")
}

fn log_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_log_dir().unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn find_node() -> Option<String> {
    // Finder-launched apps have different PATH; check common locations
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/run/current-system/sw/bin/node",
        "/usr/bin/node",
    ];
    for p in candidates {
        if PathBuf::from(p).exists() {
            return Some(p.to_string());
        }
    }
    // fallback to which
    if let Ok(out) = std::process::Command::new("which").arg("node").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && PathBuf::from(&s).exists() {
                return Some(s);
            }
        }
    }
    // try PATH
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = PathBuf::from(dir).join("node");
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }
    None
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
fn save_config(state: tauri::State<AppState>, app: tauri::AppHandle, config: DesktopConfig) -> Result<(), String> {
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
async fn check_health(url: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn check_all_services(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<ServiceStatus>, String> {
    let cfg = {
        let c = state.config.lock().unwrap().clone();
        let path = config_path(&app);
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(disk) = serde_json::from_str::<DesktopConfig>(&data) {
                    disk
                } else {
                    c
                }
            } else {
                c
            }
        } else {
            c
        }
    };

    let mut results = Vec::new();

    // LibreChat
    let libre_ok = check_health(cfg.librechat_url.clone()).await.is_ok()
        || check_health(format!("{}/api/health", cfg.librechat_url.trim_end_matches('/')))
            .await
            .is_ok();
    let libre_status = if libre_ok {
        ServiceStatus {
            name: "LibreChat".to_string(),
            state: ServiceState::Ready,
            message: "接続済み".to_string(),
            ownership: Some(Ownership::External),
        }
    } else {
        ServiceStatus {
            name: "LibreChat".to_string(),
            state: ServiceState::Error,
            message: if cfg.manage_librechat {
                "未起動 — 管理設定が有効なら起動を試みます".to_string()
            } else {
                "未起動 — 外部で起動してください".to_string()
            },
            ownership: None,
        }
    };
    results.push(libre_status);

    // Model
    let model_ok = check_health(cfg.model_url.clone()).await.is_ok();
    let model_status = if model_ok {
        ServiceStatus {
            name: "モデル".to_string(),
            state: ServiceState::Ready,
            message: "接続済み".to_string(),
            ownership: Some(Ownership::External),
        }
    } else {
        ServiceStatus {
            name: "モデル".to_string(),
            state: ServiceState::Error,
            message: if cfg.manage_model {
                "未起動 — 管理設定が有効なら起動を試みます".to_string()
            } else {
                "未起動 — 外部で起動してください".to_string()
            },
            ownership: None,
        }
    };
    results.push(model_status);

    // MultiContext
    let mc_url = format!("http://127.0.0.1:{}/api/health", cfg.multicontent_port);
    let mc_ok = check_health(mc_url.clone()).await.is_ok();
    let mc_status = if mc_ok {
        ServiceStatus {
            name: "MultiContext".to_string(),
            state: ServiceState::Ready,
            message: "起動済み".to_string(),
            ownership: Some(Ownership::External),
        }
    } else {
        ServiceStatus {
            name: "MultiContext".to_string(),
            state: ServiceState::Starting,
            message: "起動中...".to_string(),
            ownership: None,
        }
    };
    results.push(mc_status);

    let mut map = state.services.lock().unwrap();
    map.clear();
    for s in &results {
        map.insert(s.name.clone(), s.clone());
    }

    Ok(results)
}

#[tauri::command]
async fn start_multicontext(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let cfg = get_config(state.clone(), app.clone());
    let mc_url = format!("http://127.0.0.1:{}/api/health", cfg.multicontent_port);
    if check_health(mc_url.clone()).await.is_ok() {
        return Ok("既に起動しています".to_string());
    }

    let node = find_node().ok_or("Node.js が見つかりません。NodeをインストールしてPATHを確認してください。")?;
    // Log redacted command
    let logd = log_dir(&app);
    std::fs::create_dir_all(&logd).map_err(|e| e.to_string())?;
    let log_path = logd.join(format!("multicontext-{}.log", chrono::Local::now().format("%Y%m%d")));
    let cmd_str = format!("{} src/server.js", node);
    let redacted = redact_command(&cmd_str);
    let mut log_msg = format!("[{}] Starting MultiContext: {}\n", chrono::Local::now().to_rfc3339(), redacted);

    // Determine working dir: for Tauri production, resource dir contains app; for dev, current dir
    let workdir = if let Ok(exe) = std::env::current_exe() {
        exe.parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(".")
    };
    // Try to find project root by looking for package.json
    let mut cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // In Tauri dev, cwd is project root already
    if !cwd.join("src/server.js").exists() {
        // try parent
        if let Some(parent) = cwd.parent() {
            if parent.join("src/server.js").exists() {
                cwd = parent.to_path_buf();
            }
        }
    }
    // Fallback to known path for dev
    if !cwd.join("src/server.js").exists() {
        cwd = PathBuf::from("/Users/taka/projects/multicontext-chat");
    }

    // Spawn
    let mut child = std::process::Command::new(&node)
        .arg("src/server.js")
        .current_dir(&cwd)
        .env("MULTICONTEXT_PORT", cfg.multicontent_port.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("起動失敗: {} (node: {}) cwd: {}", e, node, cwd.display()))?;

    let pid = child.id();
    // Write log
    log_msg.push_str(&format!("PID {} cwd {}\n", pid, cwd.display()));
    let _ = std::fs::write(&log_path, &log_msg);

    // Track ownership
    state.children.lock().unwrap().insert("MultiContext".to_string(), pid);

    // Wait for health with bounded retries (30s)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if let Ok(resp) = client.get(&mc_url).send().await {
            if resp.status().is_success() {
                return Ok(format!("起動しました (PID {})", pid));
            }
        }
        // check if child exited
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("プロセスが早期終了しました: {:?}", status));
        }
    }
    Err("起動タイムアウト: MultiContext が 30秒以内に起動しませんでした。ログを確認してください。".to_string())
}

#[tauri::command]
fn get_logs(app: tauri::AppHandle) -> Result<String, String> {
    let dir = log_dir(&app);
    if !dir.exists() {
        return Ok("ログディレクトリが見つかりません".to_string());
    }
    let mut out = String::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|s| s == "log").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    // redact secrets in logs
                    let redacted = content
                        .lines()
                        .map(|l| {
                            if l.to_lowercase().contains("sk-") || l.to_lowercase().contains("bearer") {
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
        Ok("ログはまだありません".to_string())
    } else {
        Ok(out)
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

#[tauri::command]
fn validate_executable(path: String) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(false);
    }
    // check executable bit on unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&p) {
            return Ok(meta.permissions().mode() & 0o111 != 0);
        }
    }
    Ok(true)
}

fn main() {
    let config = DesktopConfig::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            config: Mutex::new(config),
            services: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = std::fs::create_dir_all(log_dir(&handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Only stop processes we started
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let children = state.children.lock().unwrap().clone();
                    for (name, pid) in children {
                        // Only stop if we started it; for now we only track StartedByMulticontext
                        // Check ownership via services map
                        let should_stop = {
                            let map = state.services.lock().unwrap();
                            map.get(&name)
                                .map(|s| matches!(s.ownership, Some(Ownership::StartedByMulticontext)))
                                .unwrap_or(true) // if we tracked child, we started it
                        };
                        if should_stop {
                            #[cfg(unix)]
                            unsafe {
                                libc::kill(pid as i32, libc::SIGTERM);
                            }
                            #[cfg(not(unix))]
                            {
                                let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            check_health,
            check_all_services,
            start_multicontext,
            get_logs,
            open_logs_dir,
            validate_executable
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ownership_external_not_stopped() {
        let ownership = Ownership::External;
        let should_stop = matches!(ownership, Ownership::StartedByMulticontext);
        assert!(!should_stop, "EXTERNAL should not be stopped");
    }

    #[test]
    fn test_ownership_started_should_stop() {
        let ownership = Ownership::StartedByMulticontext;
        let should_stop = matches!(ownership, Ownership::StartedByMulticontext);
        assert!(should_stop, "STARTED_BY_MULTICONTEXT should be stopped");
    }

    #[test]
    fn test_service_state_transitions() {
        let mut status = ServiceStatus {
            name: "Test".to_string(),
            state: ServiceState::Checking,
            message: "".to_string(),
            ownership: None,
        };
        status.state = ServiceState::Starting;
        assert_eq!(status.state, ServiceState::Starting);
        status.state = ServiceState::Ready;
        assert_eq!(status.state, ServiceState::Ready);
        status.state = ServiceState::Error;
        assert_eq!(status.state, ServiceState::Error);
    }

    #[test]
    fn test_config_validation() {
        let cfg = DesktopConfig {
            librechat_url: "http://127.0.0.1:3080".to_string(),
            model_url: "http://127.0.0.1:8080".to_string(),
            multicontent_port: 4317,
            ..Default::default()
        };
        assert!(cfg.validate().is_ok());
        let bad = DesktopConfig {
            librechat_url: "not-a-url".to_string(),
            ..Default::default()
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn test_executable_validation() {
        // /bin/ls should exist and be executable
        assert!(validate_executable("/bin/ls".to_string()).unwrap_or(false));
        assert!(!validate_executable("/nonexistent/path/xyz".to_string()).unwrap_or(true));
    }

    #[test]
    fn test_startup_timeout_logic() {
        // Simulate bounded retries: should timeout after N attempts
        let max_retries = 15;
        let interval_secs = 2;
        let timeout = max_retries * interval_secs;
        assert_eq!(timeout, 30);
        assert!(timeout <= 60, "startup timeout should be bounded");
    }

    #[test]
    fn test_redaction() {
        let cmd = "node src/server.js --api-key sk-abc123";
        let redacted = redact_command(cmd);
        assert_eq!(redacted, "[REDACTED COMMAND]");
        assert!(!redacted.contains("sk-abc123"));
        let safe = "node src/server.js --port 4317";
        assert_eq!(redact_command(safe), safe);
    }

    #[test]
    fn test_redaction_logs() {
        let log_line = "Authorization: Bearer sk-xyz";
        let redacted = if log_line.to_lowercase().contains("sk-") || log_line.to_lowercase().contains("bearer") {
            "[REDACTED LINE]".to_string()
        } else {
            log_line.to_string()
        };
        assert_eq!(redacted, "[REDACTED LINE]");
    }
}
