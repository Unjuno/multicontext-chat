use std::process::Command;

pub const SERVICE: &str = "com.unjuno.multicontext";
pub const ACCOUNT: &str = "librechat_api_key";

// macOS Keychain access via the built-in `security` CLI. Secrets are stored
// here (never in config.json, never logged) and injected only into the
// managed MultiContext child process environment at startup.

fn run(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("security").args(args).output()
}

/// Store (or update) the LibreChat API key in the login Keychain.
/// An empty value removes the entry.
pub fn set_key(secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return delete_key();
    }
    let out = run(&[
        "add-generic-password",
        "-U",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
        "-w",
        secret,
    ])
    .map_err(|e| format!("security add-generic-password failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Read the LibreChat API key from the login Keychain.
/// Returns None if absent or the Keychain is unavailable.
pub fn get_key() -> Option<String> {
    let out = run(&[
        "find-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
        "-w",
    ])
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// True if a key is stored.
pub fn has_key() -> bool {
    get_key().is_some()
}

/// Remove the stored key.
pub fn delete_key() -> Result<(), String> {
    let out = run(&["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE])
        .map_err(|e| format!("security delete-generic-password failed: {e}"))?;
    // 44 = item not found; treat as success for idempotency.
    if out.status.success() || out.status.code() == Some(44) {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_roundtrip() {
        let svc = "com.unjuno.mctest.roundtrip";
        let acct = "roundtrip";
        // cleanup any prior
        let _ = Command::new("security")
            .args(["delete-generic-password", "-a", acct, "-s", svc])
            .output();
        let mk = |v: &str| {
            Command::new("security")
                .args(["add-generic-password", "-U", "-a", acct, "-s", svc, "-w", v])
                .output()
        };
        assert!(mk("hello-world").unwrap().status.success());
        let out = Command::new("security")
            .args(["find-generic-password", "-a", acct, "-s", svc, "-w"])
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello-world");
        assert!(Command::new("security")
            .args(["delete-generic-password", "-a", acct, "-s", svc])
            .output()
            .unwrap()
            .status
            .success());
    }
}
