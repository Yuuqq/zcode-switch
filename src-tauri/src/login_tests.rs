use super::*;
use std::ffi::OsStr;

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
fn failed_config_restore_does_not_replace_live_login_or_poison_retry() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let original = json!({"zcodejwttoken": "source-login"});
    let original_config = json!({"apiKey": "source-key"});
    let target = Account {
        id: "broken-config".into(), name: "Broken config".into(),
        created_at: now_ts(), updated_at: now_ts(), hash: canonical_hash(&credentials()),
        credentials: credentials(), config: Some(json!({"apiKey": "enc:v1:broken"})),
        config_plaintext_fields: vec!["/apiKey".into()],
        virtual_device_mid: Some(uuid::Uuid::new_v4().to_string()),
        virtual_arms_uid: Some(store::new_arms_uid()),
    };
    save_account(&paths, &target).unwrap();
    write_live(&paths, &original).unwrap();
    write_live_config(&paths, &original_config).unwrap();
    for _ in 0..2 {
        assert!(store::switch_to(&paths, &target.id, false, false, false).is_err());
        assert_eq!(read_live(&paths).unwrap().unwrap(), original);
        assert_eq!(read_live_config(&paths).unwrap(), original_config);
    }
}

#[test]
fn failed_credential_write_restores_previous_live_config() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let original_config = json!({"apiKey": "source-key"});
    let target = Account {
        id: "target".into(), name: "Target".into(),
        created_at: now_ts(), updated_at: now_ts(), hash: canonical_hash(&credentials()),
        credentials: credentials(), config: Some(json!({"apiKey": "target-key"})),
        config_plaintext_fields: vec![],
        virtual_device_mid: Some(uuid::Uuid::new_v4().to_string()),
        virtual_arms_uid: Some(store::new_arms_uid()),
    };
    save_account(&paths, &target).unwrap();
    write_live_config(&paths, &original_config).unwrap();
    std::fs::create_dir_all(paths.live_file()).unwrap();
    for hot in [false, true] {
        assert!(store::switch_to(&paths, &target.id, false, false, hot).is_err());
        assert_eq!(read_live_config(&paths).unwrap(), original_config);
    }
}

#[test]
fn active_login_detection_matches_duplicate_detection_after_capture() {
    for plain in [credentials(), json!({"zcodejwttoken": JWT})] {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        write_live(&paths, &plain).unwrap();
        let captured = store::capture_current(&paths, Some("Captured login".into())).unwrap();
        let saved = load_account(&paths, &captured.id).unwrap();
        assert_ne!(saved.hash, canonical_hash(&plain));
        assert!(store::capture_current(&paths, None).is_err());
        let state = store::get_state(&paths).unwrap();
        assert_eq!(state.active_account_id.as_deref(), Some(captured.id.as_str()));
        assert!(state.accounts.iter().find(|a| a.id == captured.id).unwrap().is_active);

        write_live(&paths, &saved.credentials).unwrap();
        assert_eq!(store::get_state(&paths).unwrap().active_account_id.as_deref(), Some(captured.id.as_str()));
        write_live(&paths, &json!({"zcodejwttoken": "another-login"})).unwrap();
        let state = store::get_state(&paths).unwrap();
        assert!(state.active_account_id.is_none());
        assert!(state.accounts.iter().all(|a| !a.is_active));
    }
    let fixture = Fixture::new();
    assert!(store::get_state(&fixture.paths()).unwrap().active_account_id.is_none());
}

#[test]
fn windows_browser_opener_passes_oauth_query_as_one_argument_without_a_shell() {
    for url in [
        "https://zcode.z.ai/authorize?provider=zai&state=secret-state&redirect_uri=zcode%3A%2F%2Foauth%2Fcallback",
        "https://example.com/登录?name=用户%20名&state=a%26b&encoded=%25value%25",
    ] {
        let cmd = store::windows_browser_command(url);
        assert_eq!(cmd.get_program(), OsStr::new("rundll32.exe"));
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), vec![OsStr::new("url.dll,FileProtocolHandler"), OsStr::new(url)]);
    }
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
    let account = Account { id: "login-test".into(), name: "Login user".into(), created_at: now_ts(), updated_at: now_ts(), hash: canonical_hash(&plain), credentials: plain.clone(), config: Some(config.clone()), config_plaintext_fields: vec![], virtual_device_mid: None, virtual_arms_uid: None };
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
    write_account_config(&paths, &saved).unwrap();
    assert_eq!(zcrypto::decrypt_value(&read_live(&paths).unwrap().unwrap(), &secret).unwrap(), plain);
    assert_eq!(read_live_config(&paths).unwrap(), config);
    let mut broken = saved.clone();
    broken.config = Some(json!({"apiKey":"enc:v1:broken"}));
    broken.config_plaintext_fields = vec!["/apiKey".into()];
    assert!(write_account_config(&paths, &broken).is_err());
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

#[test]
fn config_origin_survives_capture_save_restore_and_portable_import() {
    let source = Fixture::new();
    let paths = source.paths();
    let secret = zcrypto::default_secret(&paths.home);
    let native = zcrypto::encrypt_with_secret("native-key", &secret).unwrap();
    let config = json!({
        "provider": {
            "plaintext/~provider": {"options": {"apiKey": KEY}},
            "native": {"options": {"apiKey": native, "otherEncrypted": native}},
        },
        "array": [{"apiKey": "plain-array-key"}],
        "empty": {"apiKey": ""},
    });
    write_live(&paths, &credentials()).unwrap();
    write_live_config(&paths, &config).unwrap();
    let captured = store::capture_current(&paths, Some("Origin test".into())).unwrap();
    let mut saved = load_account(&paths, &captured.id).unwrap();
    assert_eq!(saved.config_plaintext_fields, vec!["/array/0/apiKey", "/provider/plaintext~1~0provider/options/apiKey"]);
    assert_eq!(saved.config.as_ref().unwrap()["provider"]["native"]["options"]["apiKey"], native);
    write_account_config(&paths, &saved).unwrap();
    assert_eq!(read_live_config(&paths).unwrap(), config);
    save_account(&paths, &saved).unwrap();
    saved = load_account(&paths, &saved.id).unwrap();
    assert_eq!(saved.config_plaintext_fields.len(), 2);
    write_account_config(&paths, &saved).unwrap();
    assert_eq!(read_live_config(&paths).unwrap(), config);

    let destination = Fixture::new();
    let dest = destination.paths();
    let bundle = transfer::export_bundle_value(&paths, &[saved.clone()]).unwrap();
    let report = transfer::import_values(&dest, &[("origin.zsb".into(), bundle.clone())]).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let imported = list_accounts(&dest).unwrap().remove(0);
    assert_eq!(imported.config_plaintext_fields, saved.config_plaintext_fields);
    write_account_config(&dest, &imported).unwrap();
    let restored = read_live_config(&dest).unwrap();
    assert_eq!(restored["provider"]["plaintext/~provider"]["options"]["apiKey"], KEY);
    assert_eq!(restored["array"][0]["apiKey"], "plain-array-key");
    let imported_native = restored["provider"]["native"]["options"]["apiKey"].as_str().unwrap();
    assert!(zcrypto::is_encrypted(imported_native));
    assert_eq!(zcrypto::decrypt_with_secret(imported_native, &zcrypto::default_secret(&dest.home)).unwrap(), "native-key");

    let mut invalid = bundle;
    invalid["accounts"][0]["configPlaintextFields"] = json!(["/empty/apiKey"]);
    let invalid_dest = Fixture::new();
    let report = transfer::import_values(&invalid_dest.paths(), &[("invalid.zsb".into(), invalid)]).unwrap();
    assert!(!report.errors.is_empty());
    assert!(list_accounts(&invalid_dest.paths()).unwrap().is_empty());

    let legacy_plain = json!({"apiKey": KEY});
    let legacy_encrypted = json!({"apiKey": native, "opaque": "enc:v1:unknown-native-value"});
    let mut legacy_json = serde_json::to_value(&saved).unwrap();
    legacy_json.as_object_mut().unwrap().remove("config_plaintext_fields");
    for legacy_config in [legacy_plain, legacy_encrypted] {
        legacy_json["config"] = legacy_config.clone();
        let legacy: Account = serde_json::from_value(legacy_json.clone()).unwrap();
        write_account_config(&paths, &legacy).unwrap();
        assert_eq!(read_live_config(&paths).unwrap(), legacy_config);
        save_account(&paths, &legacy).unwrap();
        write_account_config(&paths, &load_account(&paths, &legacy.id).unwrap()).unwrap();
        assert_eq!(read_live_config(&paths).unwrap(), legacy_config);
    }

    let captured_cipher = zcrypto::encrypt_with_secret("changed-native-key", &secret).unwrap();
    let changed_live = json!({"apiKey": captured_cipher});
    write_live_config(&paths, &changed_live).unwrap();
    store::update_account_from_live(&paths, &saved.id).unwrap();
    let updated = load_account(&paths, &saved.id).unwrap();
    assert!(updated.config_plaintext_fields.is_empty());
    write_account_config(&paths, &updated).unwrap();
    assert_eq!(read_live_config(&paths).unwrap(), changed_live);
}
