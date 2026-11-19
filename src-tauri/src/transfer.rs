use crate::i18n::{tr, trf};
use crate::store::{
    canonical_hash, is_logged_in, list_accounts, now_ts, unique_name, Account, ImportReport, Paths,
};
use crate::zcrypto;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use uuid::Uuid;

const PAYLOAD_VERSION: u64 = 3;

fn decrypt_entry(
    entry: &mut Value,
    secret: &str,
    legacy: bool,
    encrypted: &mut Vec<String>,
    unreadable: &mut bool,
) -> Result<(), String> {
    for field in ["credentials", "config"] {
        if let Some(value) = entry.get_mut(field) {
            decrypt_fields(
                value,
                &format!("/{field}"),
                secret,
                legacy,
                encrypted,
                unreadable,
            )?;
        }
    }
    Ok(())
}

fn decrypt_fields(
    value: &mut Value,
    pointer: &str,
    secret: &str,
    legacy: bool,
    encrypted: &mut Vec<String>,
    unreadable: &mut bool,
) -> Result<(), String> {
    match value {
        Value::String(s) if zcrypto::is_encrypted(s) => {
            match zcrypto::decrypt_with_secret(s, secret) {
                Ok(plain) => {
                    *s = plain;
                    encrypted.push(pointer.to_string());
                }
                Err(_) if legacy => *unreadable = true,
                Err(_) => return Err(tr("err.bundle.decrypt_local")),
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                let key = key.replace('~', "~0").replace('/', "~1");
                decrypt_fields(
                    child,
                    &format!("{pointer}/{key}"),
                    secret,
                    legacy,
                    encrypted,
                    unreadable,
                )?;
            }
        }
        Value::Array(array) => {
            for (i, child) in array.iter_mut().enumerate() {
                decrypt_fields(
                    child,
                    &format!("{pointer}/{i}"),
                    secret,
                    legacy,
                    encrypted,
                    unreadable,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn export_bundle_value(paths: &Paths, accounts: &[Account]) -> Result<Value, String> {
    export_with_secret(accounts, &zcrypto::default_secret(&paths.home))
}

fn export_with_secret(accounts: &[Account], secret: &str) -> Result<Value, String> {
    let mut entries = Vec::with_capacity(accounts.len());
    for account in accounts {
        let mut entry = json!({
            "name": account.name,
            "createdAt": account.created_at,
            "credentials": account.credentials,
            "config": account.config,
        });
        let mut encrypted = vec![];
        decrypt_entry(&mut entry, secret, false, &mut encrypted, &mut false)?;
        entry["encryptedFields"] = json!(encrypted);
        entries.push(entry);
    }
    Ok(json!({
        "format": "zcode-accounts-bundle",
        "version": PAYLOAD_VERSION,
        "exportedAt": now_ts(),
        "accounts": entries,
    }))
}

fn plaintext_hash(credentials: &Value, secret: &str) -> String {
    let mut plain = credentials.clone();
    let _ = decrypt_fields(&mut plain, "", secret, true, &mut vec![], &mut false);
    canonical_hash(&plain)
}

pub fn import_values(paths: &Paths, files: &[(String, Value)]) -> Result<ImportReport, String> {
    import_with_secret(paths, files, &zcrypto::default_secret(&paths.home))
}

fn import_with_secret(
    paths: &Paths,
    files: &[(String, Value)],
    secret: &str,
) -> Result<ImportReport, String> {
    let mut report = ImportReport {
        picked: true,
        ..Default::default()
    };
    let mut accounts = list_accounts(paths)?;
    let mut hashes: HashSet<String> = accounts
        .iter()
        .map(|a| plaintext_hash(&a.credentials, secret))
        .collect();
    let mut new_accounts = vec![];

    for (filename, payload) in files {
        let result = prepare_import(
            payload,
            paths,
            secret,
            &mut accounts,
            &mut hashes,
            &mut report,
        );
        match result {
            Ok(prepared) => new_accounts.extend(prepared),
            Err(e) => report
                .errors
                .push(trf("err.import.wrap", &[("fname", filename), ("e", &e)])),
        }
    }
    if !report.errors.is_empty() {
        report.added.clear();
        return Ok(report);
    }
    commit_accounts(paths, &new_accounts, |from, to| fs::hard_link(from, to))?;
    Ok(report)
}

fn prepare_import(
    payload: &Value,
    paths: &Paths,
    secret: &str,
    accounts: &mut Vec<Account>,
    hashes: &mut HashSet<String>,
    report: &mut ImportReport,
) -> Result<Vec<Account>, String> {
    if payload.get("format").and_then(Value::as_str) != Some("zcode-accounts-bundle") {
        return Err(tr("err.bundle.unrecognized"));
    }
    let version = payload.get("version").and_then(Value::as_u64);
    if version != Some(2) && version != Some(PAYLOAD_VERSION) {
        return Err(tr("err.bundle.version"));
    }
    let entries = payload
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| tr("err.bundle.no_accounts"))?;
    let mut prepared = vec![];
    for entry in entries {
        let mut entry = entry.clone();
        if !entry.get("credentials").is_some_and(Value::is_object) {
            return Err(tr("err.bundle.no_creds"));
        }
        let encrypted: Vec<String> = if version == Some(2) {
            let mut encrypted = vec![];
            let mut unreadable = false;
            decrypt_entry(&mut entry, secret, true, &mut encrypted, &mut unreadable)?;
            if unreadable {
                report.warnings.push(tr("warn.bundle.legacy_key"));
            }
            encrypted
        } else {
            serde_json::from_value(
                entry
                    .get("encryptedFields")
                    .cloned()
                    .ok_or_else(|| tr("err.bundle.fields"))?,
            )
            .map_err(|_| tr("err.bundle.fields"))?
        };
        let credentials = &entry["credentials"];
        if !is_logged_in(credentials) {
            return Err(tr("err.bundle.no_creds"));
        }
        let hash = canonical_hash(credentials);
        let mut seen = HashSet::new();
        for pointer in &encrypted {
            if !(pointer.starts_with("/credentials/") || pointer.starts_with("/config/"))
                || !seen.insert(pointer)
            {
                return Err(tr("err.bundle.fields"));
            }
            let field = entry
                .pointer_mut(pointer)
                .ok_or_else(|| tr("err.bundle.fields"))?;
            let plain = field.as_str().ok_or_else(|| tr("err.bundle.fields"))?;
            *field = Value::String(zcrypto::encrypt_with_secret(plain, secret)?);
        }
        if !hashes.insert(hash) {
            report.skipped.push(tr("err.bundle.duplicate"));
            continue;
        }
        let base_name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| {
                zcrypto::account_identity(&entry["credentials"], &paths.home)
                    .label()
                    .unwrap_or_else(|| format!("Import {}", now_ts()))
            });
        let timestamp = now_ts();
        let account = Account {
            id: Uuid::new_v4().to_string(),
            name: unique_name(accounts, &base_name),
            created_at: entry
                .get("createdAt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&timestamp)
                .to_string(),
            updated_at: timestamp,
            hash: canonical_hash(&entry["credentials"]),
            credentials: entry["credentials"].clone(),
            config: entry.get("config").filter(|v| !v.is_null()).cloned(),
            virtual_device_mid: None,
            virtual_arms_uid: None,
        };
        report.added.push(account.name.clone());
        accounts.push(account.clone());
        prepared.push(account);
    }
    Ok(prepared)
}

fn commit_accounts(
    paths: &Paths,
    accounts: &[Account],
    mut publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if accounts.is_empty() {
        return Ok(());
    }
    paths.ensure_dirs()?;
    let stage = paths
        .accounts_dir()
        .join(format!(".import-{}", Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let mut published = vec![];
    let result = (|| {
        for account in accounts {
            let filename = format!("{}.json", account.id);
            let body = serde_json::to_vec_pretty(account).map_err(std::io::Error::other)?;
            fs::write(stage.join(filename), body)?;
        }
        for account in accounts {
            let filename = format!("{}.json", account.id);
            let destination = paths.accounts_dir().join(&filename);
            publish(&stage.join(filename), &destination)?;
            published.push(destination);
        }
        fs::remove_dir_all(&stage)
    })();
    if let Err(error) = result {
        let mut errors = vec![error.to_string()];
        for path in published {
            if let Err(e) = fs::remove_file(path) {
                errors.push(e.to_string());
            }
        }
        if stage.exists() {
            if let Err(e) = fs::remove_dir_all(stage) {
                errors.push(e.to_string());
            }
        }
        return Err(trf("err.bundle.transaction", &[("e", &errors.join("; "))]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cipher;
    use crate::store::save_account;

    struct TestStore(Paths);

    impl TestStore {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!("zsw-import-test-{}", Uuid::new_v4()));
            Self(Paths {
                data_root: home.clone(),
                home,
            })
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.home);
        }
    }

    fn account(name: &str, token: &str) -> Account {
        let credentials = json!({"zcodejwttoken": token});
        Account {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            created_at: "2020-01-02 03:04".into(),
            updated_at: "2020-01-02 03:05".into(),
            hash: canonical_hash(&credentials),
            credentials,
            config: Some(json!({"language": "en"})),
            virtual_device_mid: None,
            virtual_arms_uid: None,
        }
    }

    fn import(paths: &Paths, payload: Value, secret: &str) -> ImportReport {
        import_with_secret(paths, &[("test.zsb".into(), payload)], secret).unwrap()
    }

    #[test]
    fn round_trip_across_machine_keys_preserves_creation_and_plain_fields() {
        let source = "source-machine-key";
        let destination = "destination-machine-key";
        let token = zcrypto::encrypt_with_secret("jwt-token", source).unwrap();
        let nested = zcrypto::encrypt_with_secret("refresh-token", source).unwrap();
        let mut original = account("Portable", &token);
        original.credentials["oauth:provider:access_token"] = json!("plain-access-token");
        original.credentials["nested/~key"] = json!([nested]);
        original.config = Some(json!({"secret": token, "language": "en"}));
        let payload = export_with_secret(std::slice::from_ref(&original), source).unwrap();
        assert_eq!(payload["version"], 3);
        assert_eq!(
            payload["accounts"][0]["credentials"]["zcodejwttoken"],
            "jwt-token"
        );
        let envelope = cipher::seal(&payload, "password", cipher::FORMAT_BUNDLE).unwrap();
        assert!(!envelope.to_string().contains("jwt-token"));
        let payload = cipher::open(&envelope, "password").unwrap();
        let store = TestStore::new();
        let report = import(&store.0, payload.clone(), destination);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.warnings.is_empty());
        assert_eq!(report.added, ["Portable"]);
        let imported = list_accounts(&store.0).unwrap();
        let imported = &imported[0];
        assert_eq!(imported.created_at, original.created_at);
        assert_eq!(imported.name, original.name);
        assert_ne!(imported.id, original.id);
        let token = imported.credentials["zcodejwttoken"].as_str().unwrap();
        assert_eq!(
            zcrypto::decrypt_with_secret(token, destination).unwrap(),
            "jwt-token"
        );
        assert!(zcrypto::decrypt_with_secret(token, source).is_err());
        assert_eq!(
            imported.credentials["oauth:provider:access_token"],
            "plain-access-token"
        );
        assert_eq!(
            zcrypto::decrypt_with_secret(
                imported.credentials["nested/~key"][0].as_str().unwrap(),
                destination,
            )
            .unwrap(),
            "refresh-token"
        );
        assert_eq!(
            zcrypto::decrypt_with_secret(
                imported.config.as_ref().unwrap()["secret"]
                    .as_str()
                    .unwrap(),
                destination,
            )
            .unwrap(),
            "jwt-token"
        );
        assert_eq!(imported.config.as_ref().unwrap()["language"], "en");
        let repeated = import(&store.0, payload, destination);
        assert!(repeated.added.is_empty());
        assert_eq!(repeated.skipped.len(), 1);
    }

    #[test]
    fn same_machine_round_trip_and_empty_bundle() {
        let store = TestStore::new();
        let original = account("Plain", "plain-jwt");
        let payload = export_with_secret(std::slice::from_ref(&original), "key").unwrap();
        let report = import(&store.0, payload, "key");
        assert_eq!(report.added, ["Plain"]);
        let imported = list_accounts(&store.0).unwrap();
        assert_eq!(imported[0].credentials, original.credentials);
        assert_eq!(imported[0].config, original.config);
        let empty = export_with_secret(&[], "key").unwrap();
        assert!(import(&store.0, empty, "key").added.is_empty());
    }

    #[test]
    fn batch_names_and_duplicate_credentials() {
        let store = TestStore::new();
        save_account(&store.0, &account("Name", "existing")).unwrap();
        let payload = export_with_secret(
            &[
                account("Name", "one"),
                account("Name", "two"),
                account("Other", "two"),
            ],
            "key",
        )
        .unwrap();
        let report = import(&store.0, payload, "key");
        assert_eq!(report.added, ["Name 2", "Name 3"]);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(list_accounts(&store.0).unwrap().len(), 3);
    }

    #[test]
    fn legacy_ciphertext_local_and_foreign_keys() {
        let store = TestStore::new();
        let local = zcrypto::encrypt_with_secret("local-token", "local").unwrap();
        let foreign = zcrypto::encrypt_with_secret("foreign-token", "foreign").unwrap();
        let payload = json!({
            "format": "zcode-accounts-bundle", "version": 2,
            "accounts": [
                {"name": "Local", "createdAt": "old-date", "credentials": {"zcodejwttoken": local}},
                {"name": "Foreign", "credentials": {"zcodejwttoken": foreign}},
            ],
        });
        let report = import(&store.0, payload, "local");
        assert!(report.errors.is_empty());
        assert_eq!(report.warnings.len(), 1);
        let accounts = list_accounts(&store.0).unwrap();
        let local = accounts.iter().find(|a| a.name == "Local").unwrap();
        assert_eq!(local.created_at, "old-date");
        assert_eq!(
            zcrypto::decrypt_with_secret(
                local.credentials["zcodejwttoken"].as_str().unwrap(),
                "local"
            )
            .unwrap(),
            "local-token"
        );
        let imported_foreign = accounts.iter().find(|a| a.name == "Foreign").unwrap();
        assert_eq!(imported_foreign.credentials["zcodejwttoken"], foreign);
        assert!(!imported_foreign.created_at.is_empty());
    }

    #[test]
    fn export_rejects_unreadable_inner_ciphertext() {
        let original = account("Unreadable", "enc:v1:invalid");
        assert_eq!(
            export_with_secret(&[original], "key").unwrap_err(),
            tr("err.bundle.decrypt_local")
        );
    }

    #[test]
    fn invalid_payloads_do_not_import_other_files() {
        let store = TestStore::new();
        let good = export_with_secret(&[account("Good", "token")], "key").unwrap();
        let mut invalids = vec![];
        for version in [Value::Null, json!(1), json!(4), json!("3")] {
            let mut invalid = good.clone();
            invalid["version"] = version;
            invalids.push(invalid);
        }
        let mut invalid = good.clone();
        invalid["format"] = json!("other");
        invalids.push(invalid);
        let mut invalid = good.clone();
        invalid["accounts"] = json!({});
        invalids.push(invalid);
        let mut invalid = good.clone();
        invalid["accounts"][0]["credentials"] = json!({});
        invalids.push(invalid);
        let mut invalid = good.clone();
        invalid["accounts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"credentials": {}}));
        invalids.push(invalid);
        for fields in [
            json!(["/name"]),
            json!(["/credentials/missing"]),
            json!(null),
            json!([1]),
            json!(["/credentials/zcodejwttoken", "/credentials/zcodejwttoken"]),
        ] {
            let mut invalid = good.clone();
            invalid["accounts"][0]["encryptedFields"] = fields;
            invalids.push(invalid);
        }
        for invalid in invalids {
            let report = import_with_secret(
                &store.0,
                &[
                    ("good.zsb".into(), good.clone()),
                    ("bad.zsb".into(), invalid),
                ],
                "key",
            )
            .unwrap();
            assert!(!report.errors.is_empty());
            assert!(report.added.is_empty());
            assert!(list_accounts(&store.0).unwrap().is_empty());
        }
    }

    #[test]
    fn version_rejection_is_explicit() {
        let store = TestStore::new();
        let report = import(
            &store.0,
            json!({"format": "zcode-accounts-bundle", "version": 99}),
            "key",
        );
        assert!(report.errors[0].contains(&tr("err.bundle.version")));
    }

    #[test]
    fn publication_failure_rolls_back_and_cleans_staging() {
        let store = TestStore::new();
        let existing = account("Existing", "existing-token");
        save_account(&store.0, &existing).unwrap();
        let original =
            fs::read(store.0.accounts_dir().join(format!("{}.json", existing.id))).unwrap();
        let mut calls = 0;
        let result = commit_accounts(
            &store.0,
            &[account("First", "one"), account("Second", "two")],
            |from, to| {
                calls += 1;
                if calls == 2 {
                    Err(std::io::Error::other("injected publication failure"))
                } else {
                    fs::hard_link(from, to)
                }
            },
        );
        assert!(result.unwrap_err().contains("injected publication failure"));
        assert_eq!(calls, 2);
        assert_eq!(fs::read_dir(store.0.accounts_dir()).unwrap().count(), 1);
        assert_eq!(
            fs::read(store.0.accounts_dir().join(format!("{}.json", existing.id))).unwrap(),
            original
        );
    }

    #[test]
    fn staging_failure_and_collision_never_overwrite_existing_accounts() {
        let store = TestStore::new();
        let existing = account("Existing", "existing-token");
        save_account(&store.0, &existing).unwrap();
        let original =
            fs::read(store.0.accounts_dir().join(format!("{}.json", existing.id))).unwrap();
        let mut invalid = account("Invalid", "token");
        invalid.id = "missing/child".into();
        let mut calls = 0;
        assert!(commit_accounts(&store.0, &[invalid], |_, _| {
            calls += 1;
            Ok(())
        })
        .is_err());
        assert_eq!(calls, 0);
        let mut collision = existing.clone();
        collision.name = "Replacement".into();
        assert!(
            commit_accounts(&store.0, &[account("New", "new"), collision], |from, to| {
                fs::hard_link(from, to)
            })
            .is_err()
        );
        assert_eq!(fs::read_dir(store.0.accounts_dir()).unwrap().count(), 1);
        assert_eq!(
            fs::read(store.0.accounts_dir().join(format!("{}.json", existing.id))).unwrap(),
            original
        );
    }
}
