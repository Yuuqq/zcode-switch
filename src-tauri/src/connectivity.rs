use serde::Serialize;
use std::error::Error;
use std::io;
use std::net::ToSocketAddrs;
use std::time::{Duration, Instant};

const TARGETS: &[(&str, &str)] = &[
    ("login", "https://bigmodel.cn/"),
    ("login", "https://open.bigmodel.cn/"),
    ("login", "https://z.ai/"),
    ("login", "https://chat.z.ai/"),
    ("backend", "https://zcode.z.ai/"),
];

#[derive(Debug, Serialize)]
pub struct Probe {
    pub ok: bool,
    pub category: &'static str,
    pub status: Option<u16>,
    pub latency_ms: u128,
}

#[derive(Serialize)]
pub struct TargetResult {
    pub group: &'static str,
    pub url: &'static str,
    pub primary: Probe,
    pub direct: Option<Probe>,
}

#[derive(Serialize)]
pub struct Report {
    pub proxy: Option<String>,
    pub targets: Vec<TargetResult>,
}

pub(crate) fn redact_proxy(input: &str) -> String {
    let Ok(url) = input.parse::<tauri::Url>() else { return "[invalid proxy]".into(); };
    let Some(host) = url.host_str() else { return "[invalid proxy]".into(); };
    let host = if host.contains(':') { format!("[{}]", host.trim_matches(['[', ']'])) } else { host.to_string() };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}", url.scheme())
}

fn classify(kind: ureq::ErrorKind, status: Option<u16>, io_kind: Option<io::ErrorKind>, detail: &str) -> &'static str {
    let detail = detail.to_ascii_lowercase();
    if status == Some(407) || kind == ureq::ErrorKind::ProxyUnauthorized { "proxy_auth" }
    else if status.is_some() { "http" }
    else if io_kind == Some(io::ErrorKind::TimedOut) || detail.contains("timed out") || detail.contains("timeout") { "timeout" }
    else if detail.contains("tls") || detail.contains("certificate") || detail.contains("invalid peer") { "tls" }
    else if kind == ureq::ErrorKind::Dns { "dns" }
    else if io_kind == Some(io::ErrorKind::ConnectionRefused) || detail.contains("connection refused") { "refused" }
    else if kind == ureq::ErrorKind::InvalidProxyUrl { "invalid_proxy" }
    else if kind == ureq::ErrorKind::ProxyConnect { "proxy_connect" }
    else if kind == ureq::ErrorKind::ConnectionFailed { "connect" }
    else { "network" }
}

fn error_category(error: &ureq::Error) -> (&'static str, Option<u16>) {
    if let ureq::Error::Status(status, _) = error {
        return (classify(ureq::ErrorKind::HTTP, Some(*status), None, ""), Some(*status));
    }
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    let mut io_kind = None;
    let mut detail = String::new();
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<io::Error>() { io_kind = Some(error.kind()); }
        detail.push_str(&error.to_string());
        source = error.source();
    }
    (classify(error.kind(), None, io_kind, &detail), None)
}

fn probe(url: &str, proxy: Option<&str>) -> Probe {
    let start = Instant::now();
    let mut builder = ureq::AgentBuilder::new()
        .try_proxy_from_env(false).redirects(0)
        .timeout_connect(Duration::from_secs(2)).timeout_read(Duration::from_secs(2))
        .timeout_write(Duration::from_secs(2)).timeout(Duration::from_secs(4))
        .resolver(|netloc: &str| {
            let netloc = netloc.to_string();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || { let _ = tx.send(netloc.to_socket_addrs().map(|a| a.collect())); });
            rx.recv_timeout(Duration::from_secs(1)).unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, "DNS timeout")))
        });
    if let Some(proxy) = proxy {
        let proxy = crate::oauth::parse_proxy_url(proxy).ok().map(ureq::Proxy::new).transpose();
        match proxy {
            Ok(Some(proxy)) => builder = builder.proxy(proxy),
            _ => return Probe { ok: false, category: "invalid_proxy", status: None, latency_ms: start.elapsed().as_millis() },
        }
    }
    let (ok, category, status) = match builder.build().head(url).call() {
        Ok(response) => (true, "ok", Some(response.status())),
        Err(error) => { let (category, status) = error_category(&error); (false, category, status) }
    };
    Probe { ok, category, status, latency_ms: start.elapsed().as_millis() }
}

pub fn check(proxy: Option<String>) -> Report {
    let proxy = proxy.filter(|p| !p.trim().is_empty()).map(|p| p.trim().to_string());
    let targets = std::thread::scope(|scope| {
        let handles: Vec<_> = TARGETS.iter().map(|&(group, url)| {
            let proxy = proxy.as_deref();
            scope.spawn(move || {
                let primary = probe(url, proxy);
                let direct = (proxy.is_some() && !primary.ok).then(|| probe(url, None));
                TargetResult { group, url, primary, direct }
            })
        }).collect();
        handles.into_iter().map(|h| h.join().expect("connectivity worker")).collect()
    });
    Report { proxy: proxy.as_deref().map(redact_proxy), targets }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn classifications_never_return_transport_details() {
        use ureq::ErrorKind::*;
        for (kind, status, io, detail, expected) in [
            (Dns, None, None, "secret@proxy", "dns"),
            (ConnectionFailed, None, Some(io::ErrorKind::ConnectionRefused), "", "refused"),
            (Io, None, Some(io::ErrorKind::TimedOut), "", "timeout"),
            (Dns, None, Some(io::ErrorKind::TimedOut), "", "timeout"),
            (Io, None, None, "invalid peer certificate", "tls"),
            (ProxyUnauthorized, None, None, "user:secret", "proxy_auth"),
            (HTTP, Some(407), None, "", "proxy_auth"),
            (HTTP, Some(503), None, "", "http"),
            (ProxyConnect, None, None, "", "proxy_connect"),
            (InvalidProxyUrl, None, None, "", "invalid_proxy"),
        ] { assert_eq!(classify(kind, status, io, detail), expected); }
    }

    #[test]
    fn proxy_labels_strip_credentials_paths_queries_and_invalid_input() {
        assert_eq!(redact_proxy("http://user:p%40ss@localhost:8080/private?token=secret"), "http://localhost:8080");
        assert_eq!(redact_proxy("socks5://user:secret@[::1]:1080"), "socks5://[::1]:1080");
        assert_eq!(redact_proxy("user:secret@bad proxy"), "[invalid proxy]");
        assert_eq!(probe("https://example.invalid/", Some("user:secret@bad proxy")).category, "invalid_proxy");
    }

    #[test]
    fn probe_rejects_formats_rejected_by_the_login_webview_path() {
        let results = [
            "http://[::1]:8080",
            "http://user%40x:p%3Ass@127.0.0.1:1",
            "http://localhost",
            "http://localhost:8080/",
        ].map(|proxy| {
            assert!(crate::oauth::parse_proxy_url(proxy).is_err());
            probe("https://example.invalid/", Some(proxy)).category
        });
        assert_eq!(results, ["invalid_proxy"; 4], "probe accepted formats the login path rejects");
    }

    #[test]
    fn head_probe_classifies_http_and_connect_proxy_auth_without_body_requests() {
        for proxy in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = [0; 2048];
                let len = socket.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..len]);
                assert!(request.starts_with(if proxy { "CONNECT " } else { "HEAD " }));
                socket.write_all(if proxy { b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n" } else { b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n" }).unwrap();
            });
            let proxy_url = format!("http://{address}");
            let result = probe(if proxy { "https://example.invalid/" } else { &proxy_url }, proxy.then_some(proxy_url.as_str()));
            assert!(!result.ok);
            assert_eq!(result.category, if proxy { "proxy_auth" } else { "http" });
            server.join().unwrap();
        }
    }
}
