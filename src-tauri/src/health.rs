use reqwest::Client;
use std::time::Duration;

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

/// Result of probing the actual MultiContext usable-stack health endpoint.
/// Distinguishes "not running at all" from "running but the stack is not
/// actually usable" (e.g. missing/wrong LibreChat key, broken LibreChat link,
/// or some other service answering on the port).
#[derive(Debug, Clone, PartialEq)]
pub enum McHealth {
    Unreachable,
    Unhealthy { librechat_ok: Option<bool>, detail: String },
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
/// This requires GET {base}/api/health to return HTTP 2xx AND a JSON body with
/// `ok === true`. A 503, a body with `ok:false`, or a non-JSON body (some other
/// service occupying the port) all mean the stack is NOT ready — even though a
/// server may be listening.
pub async fn multicontext_health(client: &Client, base: &str) -> McHealth {
    let url = format!("{}/api/health", base.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                return McHealth::Unhealthy {
                    librechat_ok: None,
                    detail: format!("HTTP {}", status.as_u16()),
                };
            }
            match resp.json::<serde_json::Value>().await {
                Ok(v) => {
                    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                    if ok {
                        return McHealth::Ready;
                    }
                    let lib = v
                        .get("librechat")
                        .and_then(|x| x.get("ok"))
                        .and_then(|x| x.as_bool());
                    return McHealth::Unhealthy {
                        librechat_ok: lib,
                        detail: "LibreChat 接続に問題があります".to_string(),
                    };
                }
                Err(_) => {
                    // Successful HTTP but not valid MultiContext JSON => wrong
                    // service occupying the port.
                    McHealth::Unhealthy {
                        librechat_ok: None,
                        detail: "MultiContext ポートに想定外のサービスがあります".to_string(),
                    }
                }
            }
        }
        Err(_) => McHealth::Unreachable,
    }
}

/// Directly test a LibreChat credential by calling an authenticated route.
/// Used to distinguish "no key", "wrong key", and "LibreChat offline" so the
/// UI can show a precise, non-technical message.
pub async fn librechat_auth(base: &str, key: &str) -> AuthStatus {
    let url = format!("{}/api/me", base.trim_end_matches('/'));
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
                // Reachable but the auth route behaved unexpectedly; treat as a
                // connectivity problem rather than a credential problem.
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
        let p = serve("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n", None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                librechat_ok: None,
                detail: "HTTP 503".to_string()
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
                librechat_ok: Some(false),
                detail: "LibreChat 接続に問題があります".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_multicontext_wrong_service_not_ready() {
        // Some other HTTP server answers on the port but is not MultiContext.
        let p = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK", None);
        let c = client();
        assert_eq!(
            multicontext_health(&c, &format!("http://127.0.0.1:{}", p)).await,
            McHealth::Unhealthy {
                librechat_ok: None,
                detail: "MultiContext ポートに想定外のサービスがあります".to_string()
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
        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let p = serve(resp, None);
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
    async fn test_librechat_auth_unreachable() {
        assert_eq!(
            librechat_auth("http://127.0.0.1:1", "sk-test").await,
            AuthStatus::Unreachable
        );
    }
}
