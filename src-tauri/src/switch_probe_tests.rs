use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize}, mpsc};
use std::time::{Duration, Instant};

struct Mock {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<std::thread::JoinHandle<()>>,
    gate: Option<Arc<(Mutex<bool>, std::sync::Condvar)>>,
    started: mpsc::Receiver<()>,
}

impl Mock {
    fn new(latency: Duration, status: u16, body: &'static str) -> Self {
        Self::with_gate(latency, status, body, false)
    }

    fn with_gate(latency: Duration, status: u16, body: &'static str, blocked: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let (stopping, count) = (stop.clone(), requests.clone());
        let (tx, started) = mpsc::channel();
        let gate = blocked.then(|| Arc::new((Mutex::new(false), std::sync::Condvar::new())));
        let waiting = gate.clone();
        let worker = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                if stopping.load(Ordering::SeqCst) { break; }
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if stream.read(&mut byte).unwrap() == 0 { break; }
                    request.push(byte[0]);
                }
                count.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(());
                if let Some(gate) = &waiting {
                    let (lock, ready) = &**gate;
                    let mut released = lock.lock().unwrap();
                    while !*released { released = ready.wait(released).unwrap(); }
                }
                std::thread::sleep(latency);
                write!(stream, "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self { address, stop, requests, worker: Some(worker), gate, started }
    }

    fn release(&self) {
        if let Some(gate) = &self.gate {
            let (lock, ready) = &**gate;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.release();
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        self.worker.take().unwrap().join().unwrap();
    }
}

#[test]
fn detached_probe_events_match_switch_operation_and_outcome() {
    assert!(!in_sandbox(), "unset ZCODE_SWITCH_HOME so real probes execute");
    let mut operations = std::collections::HashSet::new();
    for (status, body, expected) in [
        (200, r#"{"code":200,"data":[{"productName":"coding","inCurrentPeriod":true,"status":"VALID"}]}"#,
            Some(probe::ProbeOutcome::Entitled { entitlements: 1, models: vec![] })),
        (200, r#"{"code":200,"data":[]}"#, Some(probe::ProbeOutcome::NoEntitlement)),
        (401, "{}", Some(probe::ProbeOutcome::AuthFailed)),
        (503, "{}", None),
    ] {
        let mock = Mock::with_gate(Duration::ZERO, status, body, true);
        let fixture = Fixture::new(&mock, 1);
        let (tx, rx) = mpsc::channel();
        let result = switch_account(&fixture.paths, &fixture.target.id, false, false, move |event| {
            tx.send(serde_json::to_value(event).unwrap()).unwrap();
        }).unwrap();
        assert!(result.switched);
        assert!(result.probe.is_none());
        assert!(uuid::Uuid::parse_str(result.operation_id.as_deref().unwrap()).is_ok());
        assert!(operations.insert(result.operation_id.clone().unwrap()));
        mock.started.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        let paths = Paths { home: fixture.paths.home.clone(), data_root: fixture.paths.data_root.clone() };
        let id = fixture.target.id.clone();
        let (renamed_tx, renamed_rx) = mpsc::channel();
        let rename = std::thread::spawn(move || {
            let _guard = store_guard();
            renamed_tx.send(store::rename_account(&paths, &id, "Renamed during probe")).unwrap();
        });
        let renamed = renamed_rx.recv_timeout(Duration::from_secs(5));
        mock.release();
        renamed.unwrap().unwrap();
        rename.join().unwrap();
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(event["operation_id"], result.operation_id.unwrap());
        assert_eq!(event["outcome"], serde_json::to_value(expected).unwrap());
        assert_eq!(mock.requests.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn synchronous_cli_wrapper_still_returns_negative_probe_inline() {
    let mock = Mock::new(Duration::ZERO, 401, "{}");
    let fixture = Fixture::new(&mock, 1);
    let result = store::switch_to(&fixture.paths, &fixture.target.id, false, false, false).unwrap();
    assert_eq!(result.probe, Some(probe::ProbeOutcome::AuthFailed));
    assert!(!probe::probe_message(result.probe.as_ref().unwrap()).is_empty());
    assert!(result.operation_id.is_none());
    assert!(serde_json::to_value(result).unwrap().get("operation_id").is_none());
    assert_eq!(mock.requests.load(Ordering::SeqCst), 1);
}

#[test]
fn captured_probe_context_does_not_reread_live_files() {
    let mock = Mock::new(Duration::ZERO, 200, r#"{"code":200,"data":[]}"#);
    let fixture = Fixture::new(&mock, 2);
    let (result, context) = {
        let _guard = store_guard();
        store::switch_mutation(&fixture.paths, &fixture.target.id, false, false, false).unwrap()
    };
    assert!(result.probe.is_none());
    assert_eq!(mock.requests.load(Ordering::SeqCst), 0);
    std::fs::remove_dir_all(&fixture.paths.home).unwrap();
    assert_eq!(context.unwrap().run(), Some(probe::ProbeOutcome::NoEntitlement));
    assert_eq!(mock.requests.load(Ordering::SeqCst), 2);
}

#[test]
fn already_active_or_failed_switch_does_not_schedule_probe() {
    let mock = Mock::new(Duration::ZERO, 200, "{}");
    let fixture = Fixture::new(&mock, 1);
    write_live(&fixture.paths, &fixture.target.credentials).unwrap();
    let (tx, rx) = mpsc::channel();
    let result = switch_account(&fixture.paths, &fixture.target.id, false, false, move |event| {
        tx.send(event).unwrap();
    }).unwrap();
    assert!(result.already_active);
    assert!(result.probe.is_none());
    assert!(matches!(rx.recv_timeout(Duration::from_secs(1)), Err(mpsc::RecvTimeoutError::Disconnected)));
    let (tx, rx) = mpsc::channel();
    assert!(switch_account(&fixture.paths, "missing", false, false, move |event| {
        tx.send(event).unwrap();
    }).is_err());
    assert!(matches!(rx.recv_timeout(Duration::from_secs(1)), Err(mpsc::RecvTimeoutError::Disconnected)));
    assert_eq!(mock.requests.load(Ordering::SeqCst), 0);
}

#[test]
fn no_channels_emit_an_inconclusive_event() {
    let mock = Mock::new(Duration::ZERO, 200, "{}");
    let fixture = Fixture::new(&mock, 0);
    let (tx, rx) = mpsc::channel();
    let result = switch_account(&fixture.paths, &fixture.target.id, false, false, move |event| {
        tx.send(event).unwrap();
    }).unwrap();
    let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(Some(event.operation_id), result.operation_id);
    assert_eq!(event.outcome, None);
    assert_eq!(mock.requests.load(Ordering::SeqCst), 0);
}

struct Fixture {
    paths: Paths,
    target: Account,
    _http: probe::test_http::Override,
}

impl Fixture {
    fn new(mock: &Mock, channels: usize) -> Self {
        let root = std::env::temp_dir().join(format!("zsw-switch-probe-{}", uuid::Uuid::new_v4()));
        let paths = Paths { home: root.clone(), data_root: root };
        let keys: Vec<_> = (0..channels).map(|i| format!("fixture-key-{}-{i}", uuid::Uuid::new_v4())).collect();
        let mut providers = serde_json::Map::new();
        for (i, key) in keys.iter().enumerate() {
            providers.insert(format!("fixture-{i}-coding-plan"), json!({"options":{"apiKey":key}}));
        }
        let credentials = json!({"zcodejwttoken":"fixture-switch-login"});
        let target = Account {
            id: "target".into(), name: "Target".into(), created_at: now_ts(), updated_at: now_ts(),
            hash: canonical_hash(&credentials), credentials,
            config: Some(json!({"provider":providers})), config_plaintext_fields: vec![],
            virtual_device_mid: Some(uuid::Uuid::new_v4().to_string()),
            virtual_arms_uid: Some(new_arms_uid()),
        };
        save_account(&paths, &target).unwrap();
        let target = load_account(&paths, &target.id).unwrap();
        let secret = zcrypto::default_secret(&paths.home);
        assert_eq!(quota::pick_channels(&target.credentials, target.config.as_ref(), &secret, false).len(), channels);
        Self { paths, target, _http: probe::test_http::Override::new(keys, &format!("http://{}", mock.address)) }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.paths.home); }
}

fn percentiles(mut samples: Vec<f64>) -> (f64, f64) {
    samples.sort_by(f64::total_cmp);
    (samples[samples.len() / 2], samples[(samples.len() * 95).div_ceil(100) - 1])
}

#[test]
#[ignore = "local HTTP benchmark: 200ms/request, 7 runs for 1/2/3 channels"]
fn switch_probe_http_benchmark() {
    assert!(!in_sandbox(), "unset ZCODE_SWITCH_HOME so real probes execute");
    assert!(!zcode_running(), "benchmark requires no running ZCode client");
    for channels in [1, 2, 3] {
        let mock = Mock::new(Duration::from_millis(200), 200, r#"{"code":200,"data":[]}"#);
        let mut returned = Vec::new();
        let mut completed = Vec::new();
        for _ in 0..7 {
            let fixture = Fixture::new(&mock, channels);
            let (tx, rx) = mpsc::channel();
            let started = Instant::now();
            let result = tauri::async_runtime::block_on(blocking(move || {
                let result = switch_account(&fixture.paths, &fixture.target.id, false, false, move |event| {
                    tx.send((event, started.elapsed())).unwrap();
                }).unwrap();
                assert!(result.switched);
                assert_eq!(read_live(&fixture.paths).unwrap().unwrap(), fixture.target.credentials);
                Ok((result, fixture))
            })).unwrap();
            returned.push(started.elapsed().as_secs_f64() * 1000.0);
            let (_, elapsed) = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            completed.push(elapsed.as_secs_f64() * 1000.0);
            drop(result);
        }
        assert_eq!(mock.requests.load(Ordering::SeqCst), channels * 7);
        let (return_median, return_p95) = percentiles(returned);
        let (probe_median, probe_p95) = percentiles(completed);
        println!("channels={channels} return_median_ms={return_median:.2} return_p95_ms={return_p95:.2} probe_median_ms={probe_median:.2} probe_p95_ms={probe_p95:.2} requests_per_run={channels} samples=7");
    }
}
