use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Map of services we started this session: label -> (pid, child handle).
pub struct Managed {
    pub children: std::sync::Mutex<HashMap<String, (u32, std::process::Child)>>,
}

impl Managed {
    pub fn new() -> Self {
        Self { children: std::sync::Mutex::new(HashMap::new()) }
    }
}

/// Redact secrets from a command string for logging.
pub fn redact(cmd: &str) -> String {
    let lowered = cmd.to_lowercase();
    for key in ["sk-", "bearer ", "token=", "password", "api_key", "authorization"] {
        if lowered.contains(key) {
            return "[REDACTED COMMAND]".to_string();
        }
    }
    cmd.to_string()
}

/// Spawn a managed service as a process-group leader so descendant trees
/// can be terminated together. stdout/stderr are redirected to `log_path`.
pub fn spawn_service(
    program: &str,
    args: &[String],
    cwd: &PathBuf,
    envs: &HashMap<String, String>,
    log_path: &PathBuf,
) -> Result<(u32, std::process::Child), String> {
    let file = std::fs::File::create(log_path).map_err(|e| format!("ログファイル作成失敗: {}", e))?;
    let err_file = file.try_clone().map_err(|e| e.to_string())?;
    let cmd_str = format!("{} {}", program, args.join(" "));
    let header = format!("[{}] {}\n", chrono_now(), redact(&cmd_str));
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs)
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err_file));
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn().map_err(|e| format!("起動失敗 ({}): {}", program, e))?;
    let pid = child.id();
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(log_path) {
        use std::io::Write;
        let _ = f.write_all(header.as_bytes());
    }
    Ok((pid, child))
}

fn chrono_now() -> String {
    // Lightweight timestamp without external deps.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/// Terminate all managed (Desktop-started) children via SIGTERM to their process group.
pub fn stop_all(managed: &Managed) {
    let mut map = managed.children.lock().unwrap();
    for (label, (pid, _child)) in map.drain() {
        #[cfg(unix)]
        unsafe {
            // Negative pid => signal the whole process group (killpg).
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
        }
        #[cfg(unix)]
        let _ = label;
    }
}

/// Terminate exactly one tracked managed child (signal its process group) and
/// reap it. Used on startup failure and on Retry to avoid orphaning or
/// double-launching. External services are never in the map, so they are never
/// affected. Safe to call when the label is absent.
pub fn terminate(managed: &Managed, label: &str) {
    let mut map = managed.children.lock().unwrap();
    if let Some((pid, mut child)) = map.remove(label) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
        }
        // Reap the direct child so it does not become a zombie.
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Remove tracked children whose process has already exited. Call before
/// (re)launching a managed service so a stale handle from a previous session
/// or a crashed child cannot shadow a fresh launch.
pub fn reap_dead(managed: &Managed) {
    let mut map = managed.children.lock().unwrap();
    let labels: Vec<String> = map.keys().cloned().collect();
    let mut dead = Vec::new();
    for label in labels {
        if let Some((_, child)) = map.get_mut(&label) {
            if matches!(child.try_wait(), Ok(Some(_))) {
                dead.push(label);
            }
        }
    }
    for label in dead {
        map.remove(&label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_command() {
        let cmd = "llama-server -m /models/gpt-oss.gguf --api-key sk-abc123";
        let r = redact(cmd);
        assert_eq!(r, "[REDACTED COMMAND]");
        assert!(!r.contains("sk-abc123"));
        let safe = "llama-server -m /models/gpt-oss.gguf --port 8080";
        assert_eq!(redact(safe), safe);
    }

    #[test]
    fn test_redact_log_line() {
        let line = "Authorization: Bearer sk-xyz";
        let lowered = line.to_lowercase();
        let out = if lowered.contains("sk-") || lowered.contains("bearer") {
            "[REDACTED LINE]".to_string()
        } else {
            line.to_string()
        };
        assert_eq!(out, "[REDACTED LINE]");
    }

    #[test]
    fn test_terminate_removes_tracked_child() {
        let managed = Managed::new();
        let log = std::env::temp_dir().join(format!("mc-test-term-{}.log", std::process::id()));
        let (_pid, child) = spawn_service(
            "sleep",
            &["5".to_string()],
            &std::path::PathBuf::from("/"),
            &HashMap::new(),
            &log,
        )
        .expect("spawn sleep");
        managed
            .children
            .lock()
            .unwrap()
            .insert("テスト".into(), (_pid, child));
        assert!(managed.children.lock().unwrap().contains_key("テスト"));
        terminate(&managed, "テスト");
        assert!(!managed.children.lock().unwrap().contains_key("テスト"));
        // The process should be gone shortly after SIGTERM.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let alive = std::process::Command::new("pgrep")
            .arg("-f")
            .arg("sleep 5")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(!alive, "terminated child should not linger");
    }

    #[test]
    fn test_reap_dead_removes_exited_child() {
        let managed = Managed::new();
        let log = std::env::temp_dir().join(format!("mc-test-reap-{}.log", std::process::id()));
        // `true` exits immediately, so it becomes a zombie the harness can reap.
        let (_pid, child) = spawn_service(
            "true",
            &[],
            &std::path::PathBuf::from("/"),
            &HashMap::new(),
            &log,
        )
        .expect("spawn true");
        managed
            .children
            .lock()
            .unwrap()
            .insert("即死".into(), (_pid, child));
        // Wait for the immediately-exiting child to actually terminate before
        // expecting reap_dead to remove it (avoids a race on try_wait).
        let exited = {
            let mut done = false;
            for _ in 0..100 {
                {
                    let mut map = managed.children.lock().unwrap();
                    if let Some((_, c)) = map.get_mut("即死") {
                        if matches!(c.try_wait(), Ok(Some(_))) {
                            done = true;
                            break;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            done
        };
        assert!(exited, "test child should have exited");
        reap_dead(&managed);
        assert!(!managed.children.lock().unwrap().contains_key("即死"));
    }
}
