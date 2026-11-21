use super::*;

const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.fixture";
const ACCESS: &str = "login-access-token-longer-than-twenty-characters";
const KEY: &str = "login-api-key-longer-than-twenty-characters";

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self { Self(std::env::temp_dir().join(format!("zsw-login-{}", uuid::Uuid::new_v4()))) }
    fn paths(&self) -> Paths { Paths { home: self.0.clone(), data_root: self.0.clone() } }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn credentials() -> Value {
    oauth::assemble_credentials_with_token("bigmodel", JWT, Some(&json!({"id":"login-user", "username":"Login user"})), Some(ACCESS), Some("refresh-token"))
}

#[test]
fn login_method_defaults_and_cancellation_is_flow_scoped() {
    assert_eq!(Settings::default().login_method(), "browser");
    let settings: Settings = serde_json::from_value(json!({"login_method":"in-app"})).unwrap();
    assert_eq!(settings.login_method(), "in-app");
    let settings: Settings = serde_json::from_value(json!({"login_method":"unknown"})).unwrap();
    assert_eq!(settings.login_method(), "browser");
    let pending = |flow: &str| PendingOAuth { provider: "bigmodel".into(), state: "state".into(), flow: flow.into() };
    let mut current = Some(pending("old"));
    assert!(cancel_oauth_flow(&mut current, Some("old")));
    assert!(!cancel_oauth_flow(&mut current, None));
    current.replace(pending("old"));
    current.replace(pending("new"));
    assert!(!cancel_oauth_flow(&mut current, Some("old")));
    assert_eq!(current.as_ref().unwrap().flow, "new");
    assert!(cancel_oauth_flow(&mut current, None));
}

#[test]
fn saved_login_snapshot_encrypts_secrets_and_all_local_readers_work() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let secret = zcrypto::default_secret(&paths.home);
    let plain = credentials();
    let config = json!({"provider": {
        "builtin:bigmodel-coding-plan": {"enabled": true, "options": {"apiKey": KEY}},
        "builtin:bigmodel-start-plan": {"enabled": true, "options": {"apiKey": JWT}}
    }});
    let account = Account { id: "login-test".into(), name: "Login user".into(), created_at: now_ts(), updated_at: now_ts(), hash: canonical_hash(&plain), credentials: plain.clone(), config: Some(config.clone()), virtual_device_mid: None, virtual_arms_uid: None };
    save_account(&paths, &account).unwrap();
    let saved = load_account(&paths, &account.id).unwrap();
    for key in ["zcodejwttoken", "oauth:bigmodel:access_token", "oauth:bigmodel:refresh_token"] {
        let value = saved.credentials[key].as_str().unwrap();
        assert!(zcrypto::is_encrypted(value));
        assert_eq!(zcrypto::decrypt_with_secret(value, &secret).unwrap(), plain[key].as_str().unwrap());
    }
    assert!(saved.config.as_ref().unwrap()["provider"]["builtin:bigmodel-coding-plan"]["options"]["apiKey"].as_str().unwrap().starts_with(zcrypto::PREFIX));
    assert_eq!(zcrypto::decrypt_value(&saved.credentials, &secret).unwrap(), plain);
    assert_eq!(zcrypto::decrypt_value(saved.config.as_ref().unwrap(), &secret).unwrap(), config);
    assert!(zcrypto::decrypt_value(&saved.credentials, "wrong-secret").is_err());
    assert_eq!(zcrypto::decrypt_value(&json!([null, {"empty":""}]), &secret).unwrap(), json!([null, {"empty":""}]));
    assert_eq!(zcrypto::account_identity(&saved.credentials, &paths.home).user_id.as_deref(), Some("login-user"));
    assert_eq!(find_same_login(&plain, "different-hash", &[saved.clone()], &paths.home), Some(0));
    assert_eq!(find_same_login(&saved.credentials, "different-hash", &[account], &paths.home), Some(0));
    assert!(!store::account_jwt_expired(&saved.credentials, &paths.home));
    for new_gen in [false, true] {
        assert_eq!(quota::pick_channels(&saved.credentials, saved.config.as_ref(), &secret, new_gen), quota::pick_channels(&plain, Some(&config), &secret, new_gen));
        assert_eq!(quota::candidate_tokens(&saved.credentials, saved.config.as_ref(), &secret, new_gen), quota::candidate_tokens(&plain, Some(&config), &secret, new_gen));
    }
    assert_eq!(quota::zai_billing_token(&json!({"oauth:active_provider":"bigmodel"}), saved.config.as_ref(), &secret).as_deref(), Some(JWT));
    write_live(&paths, &saved.credentials).unwrap();
    write_live_config(&paths, saved.config.as_ref().unwrap()).unwrap();
    assert_eq!(zcrypto::decrypt_value(&read_live(&paths).unwrap().unwrap(), &secret).unwrap(), plain);
    assert_eq!(read_live_config(&paths).unwrap(), config);
    assert!(write_live_config(&paths, &json!({"apiKey":"enc:v1:broken"})).is_err());
    assert_eq!(read_live_config(&paths).unwrap(), config);
    let bundle = transfer::export_bundle_value(&paths, &[saved]).unwrap();
    assert_eq!(bundle["accounts"][0]["credentials"], plain);
    assert_eq!(bundle["accounts"][0]["config"], config);
    assert!(!bundle.to_string().contains(zcrypto::PREFIX));
    save_account(&paths, &load_account(&paths, "login-test").unwrap()).unwrap();
    assert_eq!(zcrypto::decrypt_value(&load_account(&paths, "login-test").unwrap().credentials, &secret).unwrap(), plain);
    let mut token_only = load_account(&paths, "login-test").unwrap();
    token_only.credentials = json!({"zcodejwttoken": JWT});
    token_only.hash = canonical_hash(&token_only.credentials);
    save_account(&paths, &token_only).unwrap();
    let encrypted = load_account(&paths, "login-test").unwrap();
    assert_eq!(find_same_login(&token_only.credentials, "different-hash", &[encrypted.clone()], &paths.home), Some(0));
    assert_eq!(find_same_login(&encrypted.credentials, "different-hash", &[token_only], &paths.home), Some(0));
}

#[test]
fn actual_login_persistence_encrypts_and_updates_plaintext_or_encrypted_identity() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let raw = json!({"data": {"token": JWT, "user": {"user_id":"login-user", "name":"Login user", "email":"login@example.invalid"}}});
    let begin = || {
        *pending_oauth_guard() = Some(PendingOAuth { provider: "bigmodel".into(), state: "state".into(), flow: "login-flow".into() });
    };
    begin();
    let first = persist_oauth_account(&paths, "bigmodel", &raw, "login-flow", "mid", true).unwrap();
    let id = first["id"].as_str().unwrap();
    let saved = load_account(&paths, id).unwrap();
    assert!(saved.credentials["zcodejwttoken"].as_str().unwrap().starts_with(zcrypto::PREFIX));
    begin();
    assert_eq!(persist_oauth_account(&paths, "bigmodel", &raw, "login-flow", "mid", true).unwrap()["id"], id);
    let mut legacy = saved;
    legacy.credentials = zcrypto::decrypt_value(&legacy.credentials, &zcrypto::default_secret(&paths.home)).unwrap();
    legacy.hash = "legacy-hash".into();
    atomic_write(&paths.accounts_dir().join(format!("{id}.json")), &serde_json::to_string(&legacy).unwrap()).unwrap();
    begin();
    assert_eq!(persist_oauth_account(&paths, "bigmodel", &raw, "login-flow", "mid", true).unwrap()["id"], id);
    assert_eq!(list_accounts(&paths).unwrap().len(), 1);
    assert!(load_account(&paths, id).unwrap().credentials["zcodejwttoken"].as_str().unwrap().starts_with(zcrypto::PREFIX));
    assert_eq!(persist_oauth_account(&paths, "bigmodel", &raw, "cancelled-flow", "mid", true).unwrap_err(), "__superseded__");
}
