use crate::process::redact;
use reqwest::Client;
use std::time::Duration;

/// Remote Agents API route used by both the Node orchestrator (`src/librechat.js`)
/// and the Desktop shell. Centralized so the two codebases cannot silently drift.
pub const REMOTE_AGENTS_MODELS_PATH: &str = "/api/agents/v1/responses/models";

/// Build the Remote Agents models URL for a LibreChat base URL.
pub fn remote_agents_models_url(base: &str) -> String {
    format!(
        "{}{}",
        base.trim_end_matches('/'),
        REMOTE_AGENTS_MODELS_PATH
    )
}

/// A service is healthy ONLY when the HTTP response is successful (2xx).
/// A 404/500/connection-error/timeout is NOT healthy.
pub async fn is_healthy(client: &Client, url: &str) -> bool {
    match client.get(url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Build a shared client with a bounded timeout.
pub fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("failed to build reqwest client")
}

/// Probe a service using its real health route.
/// - MultiContext: GET {base}/api/health
/// - LibreChat:    GET {base}/health
/// - Model:        GET {base}/models (OpenAI-compatible), falling back to
///                 {base}/health and {base} (root) for non-OpenAI servers.
pub async fn probe(kind: HealthKind, base: &str, client: &Client) -> bool {
    let base = base.trim_end_matches('/');
    let urls: Vec<String> = match kind {
        HealthKind::MultiContext => vec![format!("{}/api/health", base)],
        HealthKind::LibreChat => vec![format!("{}/health", base)],
        HealthKind::Model => vec![
            format!("{}/models", base),
            format!("{}/health", base),
            base.to_string(),
        ],
    };
    for url in &urls {
        if is_healthy(client, url).await {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, Copy)]
pub enum HealthKind {
    MultiContext,
    LibreChat,
    Model,
}

/// Why a running-but-unusable MultiContext reported failure.
#[derive(Debug, Clone, PartialEq)]
pub enum McFailureKind {
    /// MultiContext is up but its LibreChat link is broken (missing/wrong key,
    /// auth failure, or LibreChat reporting an error).
    LibreChat,
    /// A different HTTP service is occupying the MultiContext port.
    WrongService,
    /// MultiContext answered but the failure is not specifically about LibreChat.
    Generic,
}

/// Result of probing the actual MultiContext usable-stack health endpoint.
/// Distinguishes "not running at all" from "running but the stack is not
/// actually usable" (e.g. missing/wrong LibreChat key, broken LibreChat link,
/// or some other service answering on the port).
#[derive(Debug, Clone, PartialEq)]
pub enum McHealth {
    Unreachable,
    Unhealthy {
        kind: McFailureKind,
        librechat_ok: Option<bool>,
        detail: String,
    },
    Ready,
}

/// Result of probing a LibreChat credential directly.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthStatus {
    Unreachable,
    Forbidden,
    Ok,
}

/// Poll until healthy or attempts exhausted. Returns true if healthy.
pub async fn wait_ready(kind: HealthKind, base: &str, attempts: u32, interval: Duration) -> bool {
    let client = client();
    for _ in 0..attempts {
        if probe(kind, base, &client).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    false
}

/// Model readiness for the fixed GPT-OSS / llama.cpp target.
///
/// A model server is only considered healthy when its OpenAI-compatible
/// `/v1/models` route returns a successful response whose body is shaped like
/// `{ "data": [...] }`. A bare 200 HTML root page (any random server) must NOT
/// be treated as "GPT-OSS ready".
pub async fn is_model_healthy(client: &Client, base: &str) -> bool {
    let url = format!("{}/models", base.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                return false;
            }
            match resp.json::<serde_json::Value>().await {
                Ok(v) => {
                    // OpenAI-compatible servers return `{"data":[...]}`; the
                    // local gpt-oss / llama.cpp server returns `{"models":[...]}`.
                    // Either shape (a non-empty array) is enough to prove this is
                    // plausibly the model API rather than a random HTTP server.
                    let arr = v
                        .get("data")
                        .or_else(|| v.get("models"))
                        .and_then(|d| d.as_array());
                    arr.map(|a| !a.is_empty()).unwrap_or(false)
                }
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

/// Poll until the model endpoint reports a valid `{data:[...]}` shape.
pub async fn wait_model_ready(base: &str, attempts: u32, interval: Duration) -> bool {
    let client = client();
    for _ in 0..attempts {
        if is_model_healthy(&client, base).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    false
}

/// Probe the actual MultiContext usable-stack health endpoint.
///
/// MultiContext returns structured JSON on both HTTP 200 and HTTP 503. We always
/// try to read and parse the body so a 503 still yields the real cause (e.g. a
/// broken LibreChat link) instead of a generic "not ready". A 2xx with
/// `ok === true` is the only truly-ready signal; any other shape (503, `ok:false`,
/// or non-MultiContext JSON from a foreign service on the port) is NOT ready.
pub async fn multicontext_health(client: &Client, base: &str) -> McHealth {
    let url = format!("{}/api/health", base.trim_end_matches('/'));
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return McHealth::Unreachable,
    };
    let status = resp.status();
    let body = match resp.text().await {
        Ok(t) => t,
        Err(_) => String::new(),
    };
    let json = serde_json::from_str::<serde_json::Value>(&body).ok();
    let is_mc = json
        .as_ref()
        .map(|v| v.get("ok").is_some() || v.get("librechat").is_some())
        .unwrap_or(false);

    if status.is_success() {
        if let Some(v) = &json {
            if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                return McHealth::Ready;
            }
            if is_mc {
                return classify_mc_failure(v);
            }
        }
        // 2xx but not valid MultiContext JSON (including valid JSON like {"foo":"bar"})
        // => foreign service on the port.
        return McHealth::Unhealthy {
            kind: McFailureKind::WrongService,
            librechat_ok: None,
            detail: redact("MultiContext ポートに想定外のサービスがあります"),
        };
    }

    // Non-2xx. If the body is recognizable MultiContext JSON, classify it.
    if is_mc {
        if let Some(v) = &json {
            return classify_mc_failure(v);
        }
    }
    // Non-2xx and not MultiContext JSON (404 from another server, 503 with HTML,
    // or any foreign service answering on the port) => wrong service.
    McHealth::Unhealthy {
        kind: McFailureKind::WrongService,
        librechat_ok: None,
        detail: redact("MultiContext ポートに別のサービスで使用されています"),
    }
}

/// Classify a MultiContext health body that is structured but not ok===true.
/// Never copies the LibreChat error verbatim into user text without redaction,
/// and never includes the credential.
fn classify_mc_failure(v: &serde_json::Value) -> McHealth {
    if let Some(lib) = v.get("librechat") {
        let ok = lib.get("ok").and_then(|x| x.as_bool());
        let err = lib
            .get("error")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let detail = if ok == Some(false) || err.as_deref().map(is_auth_like).unwrap_or(false) {
            "LibreChat 接続キーを確認してください".to_string()
        } else if let Some(e) = err {
            format!("LibreChat 接続に問題があります: {}", redact(&e))
        } else {
            "LibreChat 接続に問題があります".to_string()
        };
        return McHealth::Unhealthy {
            kind: McFailureKind::LibreChat,
            librechat_ok: ok,
            detail,
        };
    }
    McHealth::Unhealthy {
        kind: McFailureKind::Generic,
        librechat_ok: None,
        detail: redact("MultiContext が利用できません"),
    }
}

/// Heuristic: does this LibreChat error string indicate an auth/credential
/// problem (so the UI should ask the user to re-check the Remote Agents key)?
fn is_auth_like(error: &str) -> bool {
    let e = error.to_lowercase();
    ["unauthoriz", "forbidden", "401", "403", "auth", "api key", "api_key", "token", "key "]
        .iter()
        .any(|k| e.contains(k))
}

/// Directly test a LibreChat *Remote Agents API* key by calling the authenticated
/// Remote Agents models route — the same auth domain MultiContext itself depends
/// on (`src/librechat.js` -> `GET {base}/api/agents/v1/responses/models`). This is
/// NOT the normal LibreChat browser/user JWT, so the user JWT route must never be used here.
///
/// Classification:
/// * 2xx with any valid JSON body                => AuthStatus::Ok
/// * 401 / 403                                   => AuthStatus::Forbidden (bad key)
/// * connection error / timeout                  => AuthStatus::Unreachable
/// * other unexpected response                   => reachable but unhealthy; treat
///                                                  as Unreachable (not "wrong key"
///                                                  unless it is clearly auth-related)
///
/// The key is never written to logs or error strings.
pub async fn librechat_auth(base: &str, key: &str) -> AuthStatus {
    let url = remote_agents_models_url(base);
    let client = client();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", key))
        .send()
        .await;
    match resp {
        Ok(r) => {
            if r.status().is_success() {
                AuthStatus::Ok
            } else if r.status() == reqwest::StatusCode::UNAUTHORIZED
                || r.status() == reqwest::StatusCode::FORBIDDEN
            {
                AuthStatus::Forbidden
            } else {
                // Reachable but the Remote Agents route behaved unexpectedly;
                // treat as a connectivity problem rather than a credential problem.
                AuthStatus::Unreachable
            }
        }
        Err(_) => AuthStatus::Unreachable,
    }
}

/// Returns true if the server is listening (any HTTP response, including 4xx/5xx).
/// Used for readiness of services whose own `/api/health` is gated on a
/// downstream dependency (e.g. MultiContext reports 503 when LibreChat is down,
/// but it is still serving the app).
pub async fn is_listening(client: &Client, url: &str) -> bool {
    match client.get(url).send().await {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// Poll until the server is listening or attempts exhausted.
pub async fn wait_listening(base: &str, attempts: u32, interval: Duration) -> bool {
    let client = client();
    for _ in 0..attempts {
        if is_listening(&client, base).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn serve(response: &str, delay: Option<Duration>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = response.to_string();
        thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut s = stream.unwrap();
                // Consume the inbound request so the client finishes sending.
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                if let Some(d) = delay {
                    thread::sleep(d);
                }
                let _ = s.write_all(response.as_bytes());
                let _ = s.flush();
            }
        });
        port
    }

    #[tokio::test]
    async fn test_health_200_ok() {
        let p = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK", None);
        let c = client();
        let r = is_healthy(&c, &format!("http://127.0.0.1:{}/", p)).await;
        assert!(r, "expected 200 to be healthy");
    }

    #[tokio::test]
    async fn test_health_204_ok() {
        let p = serve("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n", None);
        let c = client();
        assert!(is_healthy(&c, &format!("http://127.0.0.1:{}/", p)).await);
    }

    #[tokio::test]
    async fn test_health_404_unhealthy() {
        let p = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found", None);
        let c = client();
        assert!(!is_healthy(&c, &format!("http://127.0.0.1:{}/", p)).await);
    }

    #[tokio::test]
    async fn test_health_500_unhealthy() {
        let p = serve("HTTP/1.1 500 Internal\r\nContent-Length: 0\r\n\r\n", None);
        let c = client();
        assert!(!is_healthy(&c, &format!("http://127.0.0.1:{}/", p)).await);
    }

    #[tokio::test]
    async fn test_health_conn_refused() {
        let c = client();
        assert!(!is_healthy(&c, "http://127.0.0.1:1/").await);
    }

    #[tokio::test]
    async fn test_health_timeout() {
        let p = serve("HTTP/1.1 200 OK\r\n\r\n", Some(Duration::from_secs(5)));
        let c = client();
        assert!(!is_healthy(&c, &format!("http://127.0.0.1:{}/", p)).await);
    }

    #[tokio::test]
    async fn test_model_health_valid_shape() {
        let body = "{\"data\":[{\"id\":\"gpt-oss\"}]}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        let c = client();
        assert!(
            is_model_healthy(&c, &format!("http://127.0.0.1:{}/v1", p)).await,
            "valid {{data:[...]}} must be healthy"
        );
    }

    #[tokio::test]
    async fn test_model_health_html_root_not_ready() {
        let p = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK", None);
        let c = client();
        assert!(
            !is_model_healthy(&c, &format!("http://127.0.0.1:{}/v1", p)).await,
            "a bare 200 HTML page must not be treated as GPT-OSS ready"
        );
    }

    #[tokio::test]
    async fn test_model_health_gptoss_models_shape() {
        // The local gpt-oss / llama.cpp server returns `{"models":[...]}` rather
        // than OpenAI's `{"data":[...]}`.
        let body = "{\"models\":[{\"name\":\"/models/gpt-oss.gguf\"}]}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        let c = client();
        assert!(
            is_model_healthy(&c, &format!("http://127.0.0.1:{}/v1", p)).await,
            "gpt-oss {{models:[...]}} shape must be healthy"
        );
    }

    #[tokio::test]
    async fn test_multicontext_ready() {
        let body = "{\"ok\":true,\"librechat\":{\"ok\":true}}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Ready
        );
    }

    #[tokio::test]
    async fn test_multicontext_503_not_ready() {
        // 503 with no body => a foreign/non-MultiContext service on the port.
        let p = serve("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n", None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                kind: McFailureKind::WrongService,
                librechat_ok: None,
                detail: "MultiContext ポートに別のサービスで使用されています".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_ok_false_not_ready() {
        let body = "{\"ok\":false,\"librechat\":{\"ok\":false}}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                kind: McFailureKind::LibreChat,
                librechat_ok: Some(false),
                detail: "LibreChat 接続キーを確認してください".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_503_structured_librechat_error() {
        // 503 with structured JSON must be parsed (not dropped as "HTTP 503").
        let body = "{\"ok\":false,\"librechat\":{\"ok\":false,\"error\":\"unauthorized: invalid remote agents key\"}}";
        let resp = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                kind: McFailureKind::LibreChat,
                librechat_ok: Some(false),
                detail: "LibreChat 接続キーを確認してください".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_200_non_mc_json() {
        // Some other HTTP server answers on the port with valid but non-MC JSON.
        let p = serve("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"foo\":\"bar\"}", None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                kind: McFailureKind::WrongService,
                librechat_ok: None,
                detail: "MultiContext ポートに想定外のサービスがあります".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_404_other_service() {
        // A 404 from a foreign service occupying the port.
        let p = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found", None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                kind: McFailureKind::WrongService,
                librechat_ok: None,
                detail: "MultiContext ポートに別のサービスで使用されています".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_unreachable() {
        let c = client();
        assert_eq!(
            multicontext_health(&c, "http://127.0.0.1:1").await,
            McHealth::Unreachable
        );
    }

    #[tokio::test]
    async fn test_librechat_auth_ok() {
        // Remote Agents models route returns 200 with a models payload.
        let body = "{\"data\":[{\"id\":\"gpt-oss\"}]}";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let p = serve(&resp, None);
        assert_eq!(
            librechat_auth(&format!("http://127.0.0.1:{}", p), "sk-test").await,
            AuthStatus::Ok
        );
    }

    #[tokio::test]
    async fn test_librechat_auth_forbidden() {
        let resp = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
        let p = serve(resp, None);
        assert_eq!(
            librechat_auth(&format!("http://127.0.0.1:{}", p), "sk-bad").await,
            AuthStatus::Forbidden
        );
    }

    #[tokio::test]
    async fn test_librechat_auth_forbidden_403() {
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
        let p = serve(resp, None);
        assert_eq!(
            librechat_auth(&format!("http://127.0.0.1:{}", p), "sk-bad").await,
            AuthStatus::Forbidden
        );
    }

    #[tokio::test]
    async fn test_librechat_auth_5xx_unreachable() {
        // A 5xx is not an auth failure; treat as unreachable/unhealthy.
        let resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n";
        let p = serve(resp, None);
        assert_eq!(
            librechat_auth(&format!("http://127.0.0.1:{}", p), "sk-test").await,
            AuthStatus::Unreachable
        );
    }

    #[tokio::test]
    async fn test_librechat_auth_unreachable() {
        assert_eq!(
            librechat_auth("http://127.0.0.1:1", "sk-test").await,
            AuthStatus::Unreachable
        );
    }

    #[test]
    fn test_remote_agents_models_url() {
        assert_eq!(
            remote_agents_models_url("http://127.0.0.1:3080/"),
            "http://127.0.0.1:3080/api/agents/v1/responses/models"
        );
    }
}
