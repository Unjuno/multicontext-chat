use std::path::PathBuf;
use tauri::Manager;

/// Resolve the MultiContext server root.
///
/// Production: the server files are bundled under the Tauri resource dir
/// as `multicontext/` (i.e. `Contents/Resources/multicontext/src/server.js`).
///
/// Development (`cargo tauri dev`): resources are not bundled, so fall back
/// to the repository checkout (current working directory or its parent).
pub fn server_root(app: &tauri::AppHandle, dev_cwd: &PathBuf) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("multicontext");
        // Prefer bundled dist/server.bundle.mjs (self-contained with MCP SDK)
        if bundled.join("dist").join("server.bundle.mjs").exists() {
            return bundled;
        }
        if bundled.join("src").join("server.js").exists() {
            return bundled;
        }
    }
    // dev fallback: prefer dist bundle if built
    if dev_cwd.join("dist").join("server.bundle.mjs").exists() {
        return dev_cwd.clone();
    }
    if dev_cwd.join("src").join("server.js").exists() {
        return dev_cwd.clone();
    }
    if let Some(parent) = dev_cwd.parent() {
        if parent.join("dist").join("server.bundle.mjs").exists() {
            return parent.to_path_buf();
        }
        if parent.join("src").join("server.js").exists() {
            return parent.to_path_buf();
        }
    }
    dev_cwd.clone()
}

pub fn server_entry(bundled_root: &PathBuf, dev_cwd: &PathBuf) -> PathBuf {
    // Production bundled entry has priority
    let candidates = [
        bundled_root.join("dist").join("server.bundle.mjs"),
        dev_cwd.join("dist").join("server.bundle.mjs"),
        bundled_root.join("src").join("server.js"),
        dev_cwd.join("src").join("server.js"),
    ];
    for p in candidates {
        if p.exists() {
            return p;
        }
    }
    // Fallback to src/server.js under bundled root
    bundled_root.join("src").join("server.js")
}

/// Locate a Node.js executable reliably (Finder-launched apps lack a shell PATH).
pub fn find_node() -> Option<String> {
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
    if let Ok(out) = std::process::Command::new("which").arg("node").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && PathBuf::from(&s).exists() {
                return Some(s);
            }
        }
    }
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

/// Parse host and port from a base URL like `http://127.0.0.1:8080`.
pub fn parse_host_port(url: &str) -> (String, u16) {
    let without_scheme = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    // Drop any path/query: take only the authority (host:port) part.
    let authority = without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .trim_end_matches('/');
    if let Some((host, port)) = authority.rsplit_once(':') {
        if let Ok(p) = port.parse::<u16>() {
            return (host.to_string(), p);
        }
    }
    (authority.to_string(), 80)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_host_port() {
        assert_eq!(parse_host_port("http://127.0.0.1:8080"), ("127.0.0.1".to_string(), 8080));
        assert_eq!(parse_host_port("https://example.com:3080/"), ("example.com".to_string(), 3080));
        // OpenAI-compatible base URL with /v1 path must not corrupt host/port.
        assert_eq!(parse_host_port("http://127.0.0.1:8080/v1"), ("127.0.0.1".to_string(), 8080));
        assert_eq!(parse_host_port("http://127.0.0.1:8080/v1/models"), ("127.0.0.1".to_string(), 8080));
        assert_eq!(parse_host_port("127.0.0.1:8080"), ("127.0.0.1".to_string(), 8080));
    }
}
