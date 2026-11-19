use crate::store::{atomic_write, Paths};
use std::collections::HashMap;
use std::fs;

pub type Cooldowns = HashMap<String, u64>;

pub fn load(paths: &Paths, now: u64) -> Result<Cooldowns, String> {
    let path = paths.store_dir().join("claim-cooldowns.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Cooldowns::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut cooldowns: Cooldowns = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let count = cooldowns.len();
    cooldowns.retain(|_, until| *until > now);
    if cooldowns.len() != count {
        save(paths, &cooldowns)?;
    }
    Ok(cooldowns)
}

pub fn set(paths: &Paths, id: String, until: u64, now: u64) -> Result<(), String> {
    let mut cooldowns = load(paths, now)?;
    if until > now {
        cooldowns.insert(id, until);
    } else {
        cooldowns.remove(&id);
    }
    save(paths, &cooldowns)
}

fn save(paths: &Paths, cooldowns: &Cooldowns) -> Result<(), String> {
    let body = serde_json::to_string(cooldowns).map_err(|e| e.to_string())?;
    atomic_write(&paths.store_dir().join("claim-cooldowns.json"), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStore(Paths);

    impl TestStore {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!("zsw-cooldowns-{}", uuid::Uuid::new_v4()));
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

    #[test]
    fn cooldowns_survive_reload_and_expire_at_the_deadline() {
        let store = TestStore::new();
        assert!(load(&store.0, 100).unwrap().is_empty());
        set(&store.0, "one".into(), 200, 100).unwrap();
        set(&store.0, "two".into(), 300, 100).unwrap();
        assert_eq!(load(&store.0, 199).unwrap().len(), 2);
        assert_eq!(
            load(&store.0, 200).unwrap(),
            Cooldowns::from([("two".into(), 300)])
        );
        set(&store.0, "two".into(), 200, 200).unwrap();
        assert!(load(&store.0, 200).unwrap().is_empty());
    }

    #[test]
    fn malformed_or_unreadable_state_is_not_silently_discarded() {
        let store = TestStore::new();
        store.0.ensure_dirs().unwrap();
        let path = store.0.store_dir().join("claim-cooldowns.json");
        fs::write(&path, "not-json").unwrap();
        assert!(load(&store.0, 0).is_err());
        assert!(set(&store.0, "one".into(), 1, 0).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not-json");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(load(&store.0, 0).is_err());
    }
}
