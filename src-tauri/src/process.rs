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
}
