pub struct Attempts<T> {
    current: Option<(String, T, bool)>,
}

impl<T> Default for Attempts<T> {
    fn default() -> Self {
        Self { current: None }
    }
}

impl<T: Clone> Attempts<T> {
    pub const fn new() -> Self {
        Self { current: None }
    }

    pub fn start(&mut self, id: String, value: T) -> bool {
        if self.current.is_some() {
            return false;
        }
        self.current = Some((id, value, false));
        true
    }

    pub fn submit(&mut self, id: &str) -> Option<T> {
        let (active, value, submitting) = self.current.as_mut()?;
        if active != id || *submitting {
            return None;
        }
        *submitting = true;
        Some(value.clone())
    }

    pub fn cancel(&mut self, id: &str) -> bool {
        if self
            .current
            .as_ref()
            .is_some_and(|(active, _, _)| active == id)
        {
            self.current = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempt_identity_isolates_late_submits_cancels_and_completions() {
        let mut attempts = Attempts::new();
        assert_eq!(attempts.submit("missing"), None);
        assert!(!attempts.cancel("missing"));
        assert!(attempts.start("one".into(), 1));
        assert!(!attempts.start("two".into(), 2));
        assert_eq!(attempts.submit("wrong"), None);
        assert!(!attempts.cancel("wrong"));
        assert_eq!(attempts.submit("one"), Some(1));
        assert_eq!(attempts.submit("one"), None);
        assert!(attempts.cancel("one"));
        assert!(attempts.start("two".into(), 2));
        assert!(!attempts.cancel("one"));
        assert_eq!(attempts.submit("one"), None);
        assert_eq!(attempts.submit("two"), Some(2));
        assert!(attempts.cancel("two"));
    }
}
