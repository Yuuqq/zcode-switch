use crate::zcrypto;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Default, Debug, PartialEq, Serialize)]
pub struct Counts {
    pub total: usize,
    pub readable: usize,
    pub usable: usize,
    pub unreadable: usize,
    pub no_credentials: usize,
    pub expired: usize,
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub library_path: String,
    pub library_readable: bool,
    pub counts: Counts,
    pub cli_found: bool,
    pub config_path: String,
    pub config_exists: bool,
    pub secret_set: bool,
    pub node_version: Option<String>,
    pub node_supported: bool,
}

fn decrypt(value: &Value, secret: &str) -> Result<Value, ()> {
    match value {
        Value::String(s) if zcrypto::is_encrypted(s) => zcrypto::decrypt_with_secret(s, secret).map(Value::String).map_err(|_| ()),
        Value::Array(items) => items.iter().map(|v| decrypt(v, secret)).collect(),
        Value::Object(map) => map.iter().map(|(k, v)| Ok((k.clone(), decrypt(v, secret)?))).collect(),
        _ => Ok(value.clone()),
    }
}

fn plan_key(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        let s = s.trim();
        s.contains('.') && !s.chars().any(|c| c.is_whitespace() || c == '{' || c == '$') && !s.starts_with("project-key-location:")
    })
}

fn credential_status(credentials: &Value, config: &Value, now_ms: u128) -> &'static str {
    let map = credentials.as_object().expect("validated credentials");
    for family in ["zai", "bigmodel"] {
        if map.iter().any(|(k, v)| k.contains(":coding-plan:") && k.contains(&format!(":{family}-")) && k.ends_with(":api-key") && plan_key(v)) {
            return "usable";
        }
        for provider in [format!("builtin:{family}-coding-plan"), format!("account:{family}-individual-coding-plan")] {
            if plan_key(&config["provider"][provider]["options"]["apiKey"]) { return "usable"; }
        }
    }
    if map.keys().any(|k| k.starts_with("project-key-location:v1:") || k.ends_with(":api-key-location")) { return "no_credentials"; }
    let mut jwt = credentials["zcodejwttoken"].as_str().unwrap_or_default().trim();
    if jwt.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("Bearer")) && jwt.chars().nth(6).is_some_and(char::is_whitespace) {
        jwt = jwt[6..].trim_start();
    }
    if jwt.split('.').count() != 3 { return "no_credentials"; }
    let exp = zcrypto::decode_jwt(jwt).and_then(|p| p["exp"].as_f64().or_else(|| p["exp"].as_str()?.parse().ok()));
    match exp.filter(|n| n.is_finite() && *n > 0.0) {
        Some(exp) if exp * 1000.0 > now_ms as f64 => "usable",
        Some(_) => "expired",
        None => "no_credentials",
    }
}

fn count_snapshots(dir: &Path, secret: &str, now_ms: u128) -> (Counts, bool) {
    let mut counts = Counts::default();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => return (counts, e.kind() == std::io::ErrorKind::NotFound),
    };
    let mut readable = true;
    for entry in entries {
        let Ok(entry) = entry else { readable = false; continue; };
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue; };
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { continue; }
        counts.total += 1;
        let account = (|| {
            if !fs::symlink_metadata(entry.path()).ok()?.is_file() { return None; }
            let v: Value = serde_json::from_slice(&fs::read(entry.path()).ok()?).ok()?;
            if v["id"].as_str() != Some(id) || !v["credentials"].is_object() { return None; }
            Some((decrypt(&v["credentials"], secret).ok()?, decrypt(&v["config"], secret).ok()?))
        })();
        let Some((credentials, config)) = account else { counts.unreadable += 1; continue; };
        counts.readable += 1;
        match credential_status(&credentials, &config, now_ms) {
            "usable" => counts.usable += 1,
            "expired" => counts.expired += 1,
            _ => counts.no_credentials += 1,
        }
    }
    (counts, readable)
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = [".exe", ".cmd", ".bat", ""];
    #[cfg(not(windows))]
    let extensions = [""];
    for dir in std::env::split_paths(&path) {
        for ext in extensions {
            let file = dir.join(format!("{name}{ext}"));
            if !file.is_file() { continue; }
            #[cfg(unix)]
            {
                if fs::metadata(&file).ok()?.permissions().mode() & 0o111 == 0 { continue; }
            }
            return Some(file);
        }
    }
    None
}

fn parse_node_version(text: &str) -> Option<(String, bool)> {
    let version = text.trim().strip_prefix('v')?;
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) { return None; }
    let major: u32 = parts[0].parse().ok()?;
    Some((format!("v{version}"), major >= 20))
}

fn node_version() -> Option<(String, bool)> {
    let mut command = Command::new(on_path("node")?);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                return output.status.success().then(|| parse_node_version(&String::from_utf8_lossy(&output.stdout))).flatten();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
}

fn library_home(override_home: Option<PathBuf>, profile: Option<PathBuf>, home: Option<PathBuf>, fallback: PathBuf) -> PathBuf {
    override_home.or(profile).or(home).unwrap_or(fallback)
}

#[allow(deprecated)]
pub fn inspect() -> Diagnostics {
    let system_home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let home = library_home(std::env::var_os("ZCODE_SWITCH_HOME").map(PathBuf::from), std::env::var_os("USERPROFILE").map(PathBuf::from), std::env::var_os("HOME").map(PathBuf::from), system_home.clone());
    let dir = home.join(".zcode-switch").join("accounts");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let (counts, library_readable) = count_snapshots(&dir, &zcrypto::default_secret(&home), now);
    let config = system_home.join(".config").join("magpie");
    let version = node_version();
    Diagnostics {
        library_path: dir.display().to_string(), library_readable, counts,
        cli_found: on_path("magpie").is_some(), config_exists: config.is_dir(), config_path: config.display().to_string(),
        secret_set: std::env::var_os("ZCODE_CREDENTIAL_SECRET").is_some(),
        node_supported: version.as_ref().is_some_and(|(_, supported)| *supported),
        node_version: version.map(|(version, _)| version),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_match_plugin_resolution_without_writes() {
        let root = std::env::temp_dir().join(format!("zsw-magpie-{}", uuid::Uuid::new_v4()));
        let dir = root.join(".zcode-switch/accounts");
        assert_eq!(count_snapshots(&dir, "local", 1), (Counts::default(), true));
        assert!(!root.exists());
        fs::create_dir_all(&dir).unwrap();
        let future = "a.eyJleHAiOjQxMDI0NDQ4MDB9.z";
        let past = "a.eyJleHAiOjF9.z";
        let snapshots = [
            ("paid", json!({"credentials":{"cache:coding-plan:builtin:zai-paid:api-key":"paid.key"}})),
            ("config", json!({"credentials":{},"config":{"provider":{"builtin:bigmodel-coding-plan":{"options":{"apiKey":"bm.key"}}}}})),
            ("session", json!({"credentials":{"zcodejwttoken":zcrypto::encrypt_with_secret(future, "local").unwrap()}})),
            ("expired", json!({"credentials":{"zcodejwttoken":past}})),
            ("empty", json!({"credentials":{}})),
            ("location", json!({"credentials":{"zcodejwttoken":future,"project-key-location:v1:remote":"location"}})),
            ("foreign", json!({"credentials":{"zcodejwttoken":zcrypto::encrypt_with_secret(future, "foreign").unwrap()}})),
            ("badconfig", json!({"credentials":{"zcodejwttoken":future},"config":{"apiKey":"enc:v1:bad"}})),
            ("malformed", json!({"credentials":[]})),
        ];
        let mut originals = vec![];
        for (id, mut snapshot) in snapshots {
            snapshot["id"] = json!(id);
            let file = dir.join(format!("{id}.json"));
            let text = snapshot.to_string();
            fs::write(&file, &text).unwrap();
            originals.push((file, text));
        }
        let (counts, readable) = count_snapshots(&dir, "local", 10_000);
        assert!(readable);
        assert_eq!(counts, Counts { total: 9, readable: 6, usable: 3, unreadable: 3, no_credentials: 2, expired: 1 });
        for (file, text) in originals { assert_eq!(fs::read_to_string(file).unwrap(), text); }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 9);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_versions_are_sanitized_and_require_twenty() {
        assert_eq!(parse_node_version("v20.1.2\n"), Some(("v20.1.2".into(), true)));
        assert_eq!(parse_node_version("v19.9.0"), Some(("v19.9.0".into(), false)));
        assert_eq!(parse_node_version("v24.0.0 secret"), None);
        assert_eq!(parse_node_version("not node"), None);
    }

    #[test]
    fn plugin_home_precedence_matches_accounts_module() {
        let fallback = PathBuf::from("native-home");
        assert_eq!(library_home(Some("override".into()), Some("profile".into()), Some("home".into()), fallback.clone()).join(".zcode-switch/accounts"), PathBuf::from("override/.zcode-switch/accounts"));
        assert_eq!(library_home(None, Some("profile".into()), Some("home".into()), fallback.clone()), PathBuf::from("profile"));
        assert_eq!(library_home(None, None, Some("home".into()), fallback.clone()), PathBuf::from("home"));
        assert_eq!(library_home(None, None, None, fallback.clone()), fallback);
    }
}
