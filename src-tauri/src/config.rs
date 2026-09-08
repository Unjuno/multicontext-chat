use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Ownership {
    External,
    StartedByMulticontext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Checking,
    Starting,
    Ready,
    /// The service is configured/expected but requires user action before it
    /// can become usable (e.g. an external service that is not running and not
    /// Desktop-managed, or a missing credential).
    NeedsSetup,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub name: String,
    pub state: ServiceState,
    pub message: String,
    pub ownership: Option<Ownership>,
    /// Generation token for the startup run that produced this status. The
    /// frontend ignores events whose attempt_id does not match its active run,
    /// so delayed events from a previous Retry/startup cannot corrupt state.
    #[serde(default)]
    pub attempt_id: u64,
}

fn default_false() -> bool {
    false
}

fn legacy_backend() -> String { "librechat".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopConfig {
    #[serde(default = "legacy_backend")]
    pub backend: String,
    pub librechat_path: Option<String>,
    pub librechat_url: String,
    #[serde(rename = "multicontext_port", alias = "multicontent_port")]
    pub multicontext_port: u16,
    pub model_url: String,
    pub llama_path: Option<String>,
    pub model_path: Option<String>,
    pub template_path: Option<String>,
    #[serde(default = "default_false")]
    pub manage_librechat: bool,
    #[serde(default = "default_false")]
    pub manage_model: bool,
    pub node_path: Option<String>,
    #[serde(default = "default_true")]
    pub mcp_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            backend: "local".to_string(),
            librechat_path: None,
            librechat_url: "http://127.0.0.1:3080".to_string(),
            multicontext_port: 4317,
            model_url: "http://127.0.0.1:8080/v1".to_string(),
            llama_path: None,
            model_path: None,
            template_path: None,
            manage_librechat: true,
            manage_model: true,
            node_path: None,
            mcp_enabled: true,
        }
    }
}

impl DesktopConfig {
    pub fn state_filename(&self) -> &'static str {
        if self.backend == "local" { "local-state.json" } else { "state.json" }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.backend != "local" && self.backend != "librechat" {
            return Err("接続方式は local または librechat を指定してください".into());
        }
        if self.backend == "local" {
            let url = reqwest::Url::parse(&self.model_url).map_err(|_| "モデル URL が無効です")?;
            if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"))
                || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
                return Err("ローカル接続には認証情報なしの HTTP loopback IP URL を指定してください".into());
            }
        }
        if self.backend == "librechat" && !self.librechat_url.starts_with("http://") && !self.librechat_url.starts_with("https://")
        {
            return Err("LibreChat URL は http(s) で指定してください".to_string());
        }
        if !self.model_url.starts_with("http://") && !self.model_url.starts_with("https://") {
            return Err("モデル URL は http(s) で指定してください".to_string());
        }
        if self.multicontext_port == 0 {
            return Err("MultiContext ポートは 1 以上にしてください".to_string());
        }
        if self.backend == "librechat" && self.manage_librechat {
            match &self.librechat_path {
                None => {
                    return Err(
                        "LibreChat を管理するには LibreChat ディレクトリを指定してください"
                            .to_string(),
                    )
                }
                Some(p) if !PathBuf::from(p).join("api/server/index.js").exists() => {
                    return Err(format!(
                        "LibreChat ディレクトリが無効です: {} (api/server/index.js がありません)",
                        p
                    ))
                }
                _ => {}
            }
        }
        if self.manage_model {
            for (field, val) in [
                ("llama-server", &self.llama_path),
                ("モデルファイル", &self.model_path),
                ("チャットテンプレート", &self.template_path),
            ] {
                match val {
                    None => return Err(format!("{} を指定してください", field)),
                    Some(p) if !PathBuf::from(p).exists() => {
                        return Err(format!("{} が見つかりません: {}", field, p))
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_backend_needs_no_librechat_and_preserves_legacy_configs() {
        let old: DesktopConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(old.backend, "librechat");
        let mut local = DesktopConfig { backend: "local".into(), manage_model: false, ..Default::default() };
        assert!(local.validate().is_ok());
        local.model_url = "http://example.com/v1".into();
        assert!(local.validate().is_err());
        local.backend = "unknown".into();
        assert!(local.validate().is_err());
    }

    #[test]
    fn test_config_validation_ok() {
        let cfg = DesktopConfig {
            librechat_url: "http://127.0.0.1:3080".to_string(),
            model_url: "http://127.0.0.1:8080".to_string(),
            multicontext_port: 4317,
            manage_librechat: false,
            manage_model: false,
            ..Default::default()
        };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_config_validation_bad_url() {
        let cfg = DesktopConfig {
            backend: "librechat".into(),
            librechat_url: "not-a-url".to_string(),
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn local_ignores_unused_librechat_url_but_validates_model_url() {
        let mut cfg = DesktopConfig {
            backend: "local".into(), librechat_url: "unused-invalid".into(),
            manage_model: false, manage_librechat: true, librechat_path: None,
            ..Default::default()
        };
        assert!(cfg.validate().is_ok());
        assert_eq!(cfg.librechat_url, "unused-invalid");
        cfg.model_url = "https://example.com".into();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn test_config_validation_managed_librechat_missing_path() {
        let cfg = DesktopConfig {
            backend: "librechat".into(),
            manage_librechat: true,
            librechat_path: None,
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn test_config_validation_managed_librechat_invalid_path() {
        let cfg = DesktopConfig {
            backend: "librechat".into(),
            manage_librechat: true,
            librechat_path: Some("/nonexistent/librechat".to_string()),
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn test_config_validation_managed_model_missing() {
        let cfg = DesktopConfig {
            manage_model: true,
            llama_path: Some("/usr/bin/llama-server".to_string()),
            model_path: None,
            template_path: None,
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn test_port_alias_migration() {
        // Old config files used the misspelled field `multicontent_port`.
        // It must deserialize into `multicontext_port` (backward compatible).
        let old = r#"{"librechat_url":"http://127.0.0.1:3080","multicontent_port":4317,"model_url":"http://127.0.0.1:8080/v1"}"#;
        let cfg: DesktopConfig = serde_json::from_str(old).unwrap();
        assert_eq!(cfg.multicontext_port, 4317);
        // The canonical spelling must also round-trip.
        let new = r#"{"librechat_url":"http://127.0.0.1:3080","multicontext_port":9999,"model_url":"http://127.0.0.1:8080/v1"}"#;
        let cfg2: DesktopConfig = serde_json::from_str(new).unwrap();
        assert_eq!(cfg2.multicontext_port, 9999);
    }

    #[test]
    fn test_config_default_managed_true() {
        let cfg = DesktopConfig::default();
        assert_eq!(cfg.backend, "local");
        assert_eq!(cfg.state_filename(), "local-state.json");
        assert!(
            cfg.manage_model,
            "new installs must default to managed GPT-OSS"
        );
        assert!(
            cfg.manage_librechat,
            "new installs must default to managed LibreChat"
        );
    }

    #[test]
    fn test_config_old_saved_preserved() {
        // Old saved config without managed fields must deserialize to false (serde default),
        // preserving existing behavior; new installs get true via Default::default().
        let old =
            r#"{"librechat_url":"http://127.0.0.1:3080","model_url":"http://127.0.0.1:8080/v1"}"#;
        let cfg: DesktopConfig = serde_json::from_str(old).unwrap();
        assert!(!cfg.manage_model);
        assert!(!cfg.manage_librechat);
        // Explicit true must be preserved.
        let with = r#"{"librechat_url":"http://127.0.0.1:3080","model_url":"http://127.0.0.1:8080/v1","manage_model":true,"manage_librechat":true}"#;
        let cfg2: DesktopConfig = serde_json::from_str(with).unwrap();
        assert!(cfg2.manage_model);
        assert!(cfg2.manage_librechat);
    }
}
