use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde_json::{json, Value};
use sha2::Sha256;

pub const FORMAT_BUNDLE: &str = "zsw-accounts-bundle";
pub const KDF_ITERS: u32 = 100_000;

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, KDF_ITERS, &mut key);
    key
}

pub fn seal(payload: &Value, password: &str, format: &str) -> Result<Value, String> {
    if password.trim().is_empty() {
        return Err(crate::i18n::tr("err.cipher.pw_empty"));
    }
    if password.chars().count() < 6 {
        return Err(crate::i18n::tr("err.cipher.pw_short"));
    }
    let mut salt = [0u8; 16];
    let mut nonce_b = [0u8; 12];
    aes_gcm::aead::OsRng.fill_bytes(&mut salt);
    aes_gcm::aead::OsRng.fill_bytes(&mut nonce_b);

    let plain = serde_json::to_vec(payload)
        .map_err(|e| crate::i18n::trf("err.serialize", &[("e", &e.to_string())]))?;
    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| crate::i18n::trf("err.cipher.key", &[("e", &e.to_string())]))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_b), plain.as_slice())
        .map_err(|e| crate::i18n::trf("err.cipher.encrypt", &[("e", &e.to_string())]))?;
    let (data, tag) = ct.split_at(ct.len() - 16);

    Ok(json!({
        "format": format,
        "version": 1,
        "kdf": { "algo": "pbkdf2-hmac-sha256", "iters": KDF_ITERS, "salt": B64.encode(salt) },
        "cipher": { "algo": "aes-256-gcm", "nonce": B64.encode(nonce_b), "tag": B64.encode(tag), "data": B64.encode(data) },
    }))
}

pub fn open(envelope: &Value, password: &str) -> Result<Value, String> {
    if password.trim().is_empty() {
        return Err(crate::i18n::tr("err.cipher.pw_empty"));
    }
    if envelope.get("format").and_then(Value::as_str) != Some(FORMAT_BUNDLE) {
        return Err(crate::i18n::tr("err.import.not_bundle_plain"));
    }
    if envelope.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(crate::i18n::tr("err.cipher.version"));
    }
    let kdf = envelope
        .get("kdf")
        .ok_or_else(|| crate::i18n::tr("err.cipher.no_kdf"))?;
    let c = envelope
        .get("cipher")
        .ok_or_else(|| crate::i18n::tr("err.cipher.no_cipher"))?;
    if kdf.get("algo").and_then(Value::as_str) != Some("pbkdf2-hmac-sha256")
        || kdf.get("iters").and_then(Value::as_u64) != Some(u64::from(KDF_ITERS))
        || c.get("algo").and_then(Value::as_str) != Some("aes-256-gcm")
        || !kdf.get("salt").is_some_and(Value::is_string)
        || ["nonce", "tag", "data"]
            .iter()
            .any(|key| !c.get(*key).is_some_and(Value::is_string))
    {
        return Err(crate::i18n::tr("err.cipher.metadata"));
    }
    let salt = B64
        .decode(kdf.get("salt").and_then(|v| v.as_str()).unwrap_or_default())
        .map_err(|_| crate::i18n::tr("err.cipher.bad_salt"))?;
    let nonce_b = B64
        .decode(c.get("nonce").and_then(|v| v.as_str()).unwrap_or_default())
        .map_err(|_| crate::i18n::tr("err.cipher.bad_nonce"))?;
    let tag = B64
        .decode(c.get("tag").and_then(|v| v.as_str()).unwrap_or_default())
        .map_err(|_| crate::i18n::tr("err.cipher.bad_tag"))?;
    let data = B64
        .decode(c.get("data").and_then(|v| v.as_str()).unwrap_or_default())
        .map_err(|_| crate::i18n::tr("err.cipher.bad_data"))?;
    if nonce_b.len() != 12 {
        return Err(crate::i18n::tr("err.cipher.nonce_len"));
    }
    if salt.len() != 16 || tag.len() != 16 {
        return Err(crate::i18n::tr("err.cipher.metadata"));
    }

    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| crate::i18n::trf("err.cipher.key", &[("e", &e.to_string())]))?;
    let mut buf = data.clone();
    buf.extend_from_slice(&tag);
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce_b), buf.as_slice())
        .map_err(|_| crate::i18n::coded("wrong_password", "err.cipher.wrong_pw", &[]))?;
    serde_json::from_slice(&plain)
        .map_err(|e| crate::i18n::trf("err.cipher.bad_plain", &[("e", &e.to_string())]))
}

pub fn is_sealed(v: &Value) -> bool {
    v.get("kdf").is_some() && v.get("cipher").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_short_password_bundle() -> Value {
        let salt = [1u8; 16];
        let nonce = [2u8; 12];
        let key = derive_key("x", &salt);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), b"{}".as_ref())
            .unwrap();
        let (data, tag) = ciphertext.split_at(ciphertext.len() - 16);
        json!({
            "format": FORMAT_BUNDLE, "version": 1,
            "kdf": {"algo": "pbkdf2-hmac-sha256", "iters": KDF_ITERS, "salt": B64.encode(salt)},
            "cipher": {"algo": "aes-256-gcm", "nonce": B64.encode(nonce), "tag": B64.encode(tag), "data": B64.encode(data)},
        })
    }

    #[test]
    fn export_password_rule_and_legacy_short_password_import() {
        for password in ["", "      ", "short", "😀😀😀😀😀"] {
            assert!(seal(&json!({}), password, FORMAT_BUNDLE).is_err());
        }
        for password in ["123456", "😀😀😀😀😀😀"] {
            let sealed = seal(&json!({"test": true}), password, FORMAT_BUNDLE).unwrap();
            assert_eq!(open(&sealed, password).unwrap(), json!({"test": true}));
        }
        let legacy = legacy_short_password_bundle();
        assert_eq!(open(&legacy, "x").unwrap(), json!({}));
        assert!(open(&legacy, " ").is_err());
        assert!(open(&legacy, "wrong").is_err());
    }

    #[test]
    fn rejects_envelope_versions_formats_and_metadata() {
        let valid = legacy_short_password_bundle();
        for version in [json!(0), json!(2), json!("1"), Value::Null] {
            let mut invalid = valid.clone();
            invalid["version"] = version;
            assert_eq!(
                open(&invalid, "x").unwrap_err(),
                crate::i18n::tr("err.cipher.version")
            );
        }
        for (pointer, value) in [
            ("/format", json!("other")),
            ("/kdf/algo", json!("other")),
            ("/kdf/iters", json!(1)),
            ("/kdf/iters", json!("100000")),
            ("/kdf/salt", json!(B64.encode([0u8; 15]))),
            ("/kdf/salt", json!("!")),
            ("/cipher/algo", json!("other")),
            ("/cipher/nonce", json!(B64.encode([0u8; 11]))),
            ("/cipher/tag", json!(B64.encode([0u8; 15]))),
            ("/cipher/data", json!("!")),
            ("/kdf", Value::Null),
            ("/cipher", Value::Null),
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(open(&invalid, "x").is_err(), "{pointer}");
        }
        assert!(open(&json!({}), "x").is_err());
    }
}
