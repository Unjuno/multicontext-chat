/// Fixed GPT-OSS / llama.cpp serving profile.
///
/// GPT-OSS is the intended desktop model target, so a sensible built-in
/// default is acceptable. Tuning is kept in one place (here) rather than
/// scattered through the startup code, and can be overridden by an explicit
/// `GptOssProfile` if advanced configuration is ever needed.
#[derive(Debug, Clone, PartialEq)]
pub struct GptOssProfile {
    pub reasoning_effort: String,
    pub ctx_size: u16,
    pub parallel: u8,
}

impl Default for GptOssProfile {
    fn default() -> Self {
        Self {
            reasoning_effort: "low".to_string(),
            ctx_size: 8192,
            parallel: 4,
        }
    }
}

/// Build the llama-server argument list for the GPT-OSS profile.
///
/// `llama` (the program) is passed separately to `spawn_service`; this returns
/// only the arguments. The corrected GPT-OSS Jinja template and chat-template
/// kwargs are always supplied so reasoning output is well-formed.
pub fn build_model_args(
    profile: &GptOssProfile,
    model: &str,
    template: &str,
    host: &str,
    port: u16,
) -> Vec<String> {
    vec![
        "-m".into(),
        model.into(),
        "--jinja".into(),
        "--chat-template-file".into(),
        template.into(),
        "--chat-template-kwargs".into(),
        format!(r#"{{"reasoning_effort":"{}"}}"#, profile.reasoning_effort),
        "--host".into(),
        host.into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        profile.ctx_size.to_string(),
        "--parallel".into(),
        profile.parallel.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_profile() {
        let p = GptOssProfile::default();
        assert_eq!(p.reasoning_effort, "low");
        assert_eq!(p.ctx_size, 8192);
        assert_eq!(p.parallel, 4);
    }

    #[test]
    fn test_build_model_args_shape() {
        let p = GptOssProfile::default();
        let args = build_model_args(&p, "/m/gpt-oss.gguf", "/t/gpt-oss.jinja", "127.0.0.1", 8080);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert!(s.contains(&"-m"));
        assert_eq!(s[s.iter().position(|x| *x == "-m").unwrap() + 1], "/m/gpt-oss.gguf");
        assert!(s.contains(&"--jinja"));
        assert!(s.contains(&"--chat-template-file"));
        assert!(s.contains(&"--host"));
        assert!(s.contains(&"--port"));
        assert_eq!(s[s.iter().position(|x| *x == "--port").unwrap() + 1], "8080");
        let ctx = s[s.iter().position(|x| *x == "--ctx-size").unwrap() + 1];
        assert_eq!(ctx, "8192");
        let par = s[s.iter().position(|x| *x == "--parallel").unwrap() + 1];
        assert_eq!(par, "4");
        let kwargs = s[s.iter().position(|x| *x == "--chat-template-kwargs").unwrap() + 1];
        assert!(kwargs.contains("reasoning_effort"));
        assert!(kwargs.contains("low"));
    }

    #[test]
    fn test_build_model_args_override() {
        let p = GptOssProfile {
            reasoning_effort: "high".to_string(),
            ctx_size: 16384,
            parallel: 2,
        };
        let args = build_model_args(&p, "/m/x.gguf", "/t/x.jinja", "0.0.0.0", 9000);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert_eq!(s[s.iter().position(|x| *x == "--ctx-size").unwrap() + 1], "16384");
        assert_eq!(s[s.iter().position(|x| *x == "--parallel").unwrap() + 1], "2");
        let kwargs = s[s.iter().position(|x| *x == "--chat-template-kwargs").unwrap() + 1];
        assert!(kwargs.contains("high"));
    }
}
