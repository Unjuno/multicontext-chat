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

    fn serve(response: &'static str, delay: Option<Duration>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
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
}
