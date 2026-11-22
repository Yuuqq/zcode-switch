use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
use std::time::Instant;

struct Server {
    url: String,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(latency: Duration, rate_limits: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = requests.clone();
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut workers = vec![];
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let count = count.clone();
                        workers.push(std::thread::spawn(move || {
                            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                            let mut request = Vec::new();
                            let mut buf = [0; 1024];
                            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                                let n = stream.read(&mut buf).unwrap();
                                if n == 0 { return; }
                                request.extend_from_slice(&buf[..n]);
                            }
                            let index = count.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(latency);
                            let (status, body) = if index < rate_limits {
                                ("429 Too Many Requests", "{}".to_string())
                            } else {
                                ("200 OK", json!({"code":200,"data":{"limits":[{
                                    "type":"TOKENS_LIMIT", "usage":100, "currentValue":10
                                }],"plans":[],"balances":[]}}).to_string())
                            };
                            write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(1)),
                    Err(e) => panic!("mock accept: {e}"),
                }
            }
            for worker in workers { worker.join().unwrap(); }
        });
        Self { url, requests, stop, thread: Some(thread) }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
#[ignore = "fixed-latency quota HTTP benchmark"]
fn quota_http_benchmark() {
    let channels = vec![
        Channel::Monitor("monitor-a".into()), Channel::Monitor("monitor-b".into()),
        Channel::Monitor("monitor-c".into()), Channel::ZaiBilling("billing-a".into()),
        Channel::ZaiBilling("billing-b".into()),
    ];
    let mut samples = vec![];
    for run in 1..=7 {
        let server = Server::new(Duration::from_millis(200), 0);
        let start = Instant::now();
        let result = query_channels_at(&channels, &|url| {
            format!("{}/{}", server.url, if url == QUOTA_LIMIT_URL { "limit" } else if url == SUBSCRIPTION_URL { "subscription" } else { "billing" })
        }).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(!result.plans.is_empty());
        let requests = server.requests.load(Ordering::SeqCst);
        assert_eq!(requests, 8);
        println!("run={run} channels=5 accounts=1 latency_ms=200 wall_ms={ms:.2} requests={requests}");
        samples.push(ms);
    }
    samples.sort_by(f64::total_cmp);
    println!("median_ms={:.2} p95_ms={:.2} requests_per_run=8 samples=7", samples[3], samples[6]);
}

#[test]
fn http_429_retries_and_retry_opt_out() {
    let server = Server::new(Duration::ZERO, 3);
    let start = Instant::now();
    assert!(http_get_json(&server.url, "token", true).is_ok());
    assert_eq!(server.requests.load(Ordering::SeqCst), 4);
    assert!(start.elapsed() >= Duration::from_millis(6000));

    let server = Server::new(Duration::ZERO, usize::MAX);
    assert!(http_get_json(&server.url, "token", false).is_err());
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
}

#[test]
fn parallel_channels_preserve_serial_results_and_dependencies() {
    use std::collections::HashSet;
    use std::sync::Mutex;

    let channels = vec![
        Channel::Monitor("a".into()), Channel::ZaiBilling("b".into()),
        Channel::Monitor("c".into()), Channel::Monitor("d".into()),
    ];
    for scenario in 0..7 {
        let limits_done = Mutex::new(HashSet::new());
        let fetch = |url: &str, token: &str| {
            if scenario == 1 || ((scenario == 2 || scenario == 5) && token == "a") {
                return Err(format!("error-{token}"));
            }
            if scenario == 3 || scenario == 5 {
                return Ok(json!({"code":400,"msg":"没有资格"}));
            }
            if url == SUBSCRIPTION_URL {
                assert!(limits_done.lock().unwrap().contains(token));
                if scenario == 4 { return Err("subscription unavailable".into()); }
                return Ok(json!({"code":200,"data":[]}));
            }
            if url == QUOTA_LIMIT_URL {
                if token == "a" { std::thread::sleep(Duration::from_millis(5)); }
                limits_done.lock().unwrap().insert(token.to_string());
            }
            if scenario == 6 { return Ok(json!({"code":200,"data":{"limits":[]}})); }
            if scenario == 0 && url != QUOTA_LIMIT_URL {
                return Ok(json!({"code":200,"data":{"plans":[{
                    "plan_id":"pro", "name":"Pro", "status":"active"
                }],"balances":[]}}));
            }
            Ok(json!({"code":200,"data":{"limits":[{
                "type":"TOKENS_LIMIT","usage":100,"currentValue":10
            }],"plans":[],"balances":[]}}))
        };
        let normalize = |result: Result<QuotaOverview, String>| result.map(|mut overview| {
            overview.refreshed_at = 0;
            serde_json::to_value(overview).unwrap()
        });
        let serial = normalize(query_channels_serial_via(&channels, &fetch));
        limits_done.lock().unwrap().clear();
        assert_eq!(normalize(query_channels_via(&channels, &fetch)), serial);
    }
    assert!(query_channels_via(&[], &|_, _| panic!("empty channels must not fetch")).is_err());
}

#[test]
fn channel_concurrency_is_bounded() {
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let channels: Vec<_> = (0..8).map(|i| Channel::ZaiBilling(i.to_string())).collect();
    let result = query_channels_via(&channels, &|_, _| {
        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(n, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(10));
        active.fetch_sub(1, Ordering::SeqCst);
        Ok(json!({"code":200,"data":{"balances":[],"plans":[]}}))
    }).unwrap();
    assert!(result.is_empty);
    assert!((2..=3).contains(&peak.load(Ordering::SeqCst)));
}
