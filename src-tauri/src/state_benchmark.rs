use super::*;

struct Fixture(Paths);

impl Fixture {
    fn new(count: usize) -> Self {
        let home = std::env::temp_dir().join(format!("zsw-state-bench-{}", Uuid::new_v4()));
        let paths = Paths { home: home.clone(), data_root: home };
        save_settings(&paths, &Settings::default()).unwrap();
        for i in 0..count {
            let credentials = crate::oauth::assemble_credentials_with_token(
                "bigmodel", "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.fixture",
                Some(&json!({"id":format!("fixture-user-{i}"),"username":format!("User {i}")})),
                Some("fixture-access-token-longer-than-twenty-characters"), Some("fixture-refresh-token"),
            );
            let account = Account {
                id: format!("account-{i:03}"), name: format!("Account {i}"),
                created_at: now_ts(), updated_at: now_ts(), hash: canonical_hash(&credentials),
                credentials, config: Some(json!({"provider":{}})), config_plaintext_fields: vec![],
                virtual_device_mid: Some(Uuid::new_v4().to_string()), virtual_arms_uid: Some(new_arms_uid()),
            };
            save_account(&paths, &account).unwrap();
            if i == 0 {
                write_live(&paths, &load_account(&paths, &account.id).unwrap().credentials).unwrap();
            }
        }
        Self(paths)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0.home); }
}

fn summarize(mut samples: Vec<f64>) -> (f64, f64) {
    samples.sort_by(f64::total_cmp);
    (samples[samples.len() / 2], samples[(samples.len() * 95).div_ceil(100) - 1])
}

fn measure(paths: &Paths, calls: usize, expected: usize) -> f64 {
    let started = Instant::now();
    for _ in 0..calls {
        let state = get_state(paths).unwrap();
        assert_eq!(state.accounts.len(), expected);
        assert_eq!(state.accounts.iter().filter(|a| a.is_active).count(), 1);
        assert!(state.accounts.iter().all(|a| a.has_user_info && !a.jwt_expired));
        std::hint::black_box(state);
    }
    if calls == 0 { 0.0 } else { started.elapsed().as_secs_f64() * 1000.0 }
}

#[test]
#[ignore = "real filesystem get_state benchmark with frontend polling trace replay"]
fn get_state_poll_benchmark() {
    assert!(!in_sandbox(), "unset ZCODE_SWITCH_HOME to include real process detection");
    assert!(std::env::var_os("ZCODE_CREDENTIAL_SECRET").is_none(), "unset secret override to include default-secret resolution");
    let workload = std::env::var("GET_STATE_POLL_WORKLOAD").expect("run scripts/state-poll-benchmark.mjs and pass its JSON path");
    let workload: Value = serde_json::from_str(&fs::read_to_string(workload).unwrap()).unwrap();
    let fixture = Fixture::new(20);
    measure(&fixture.0, 1, 20);
    let (median, p95) = summarize((0..21).map(|_| measure(&fixture.0, 1, 20)).collect());
    println!("accounts=20 per_call_median_ms={median:.2} per_call_p95_ms={p95:.2} samples=21");
    for scenario in workload["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let calls = scenario["calls"].as_u64().unwrap() as usize;
        let peak = scenario["peak_in_flight"].as_u64().unwrap();
        let (median, p95) = summarize((0..7).map(|_| measure(&fixture.0, calls, 20)).collect());
        println!("scenario={name} calls_per_min={calls} peak_in_flight={peak} backend_work_median_ms={median:.2} backend_work_p95_ms={p95:.2} samples=7");
    }
}
