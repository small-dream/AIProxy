//! Built-in SSL proxying exclusions.
//!
//! Keep this list narrow: an entry belongs here only when TLS interception is
//! known to break an app or platform flow. The same JSON file is imported by
//! the frontend, so the settings fallback and the runtime cannot drift apart.

use std::sync::OnceLock;

const DEFAULT_SSL_PROXYING_EXCLUSIONS_JSON: &str =
    include_str!("../../../packages/shared-types/src/ssl-proxying-defaults.json");

/// Hosts excluded from interception when the user has not customized the list.
pub fn default_ssl_proxying_exclusions() -> &'static [String] {
    static EXCLUSIONS: OnceLock<Vec<String>> = OnceLock::new();

    EXCLUSIONS
        .get_or_init(|| {
            serde_json::from_str(DEFAULT_SSL_PROXYING_EXCLUSIONS_JSON)
                .expect("bundled SSL proxying exclusions must be valid JSON")
        })
        .as_slice()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn defaults_are_non_empty_and_unique() {
        let patterns = default_ssl_proxying_exclusions();
        assert!(!patterns.is_empty());

        let mut seen = HashSet::new();
        for pattern in patterns {
            assert!(
                !pattern.trim().is_empty(),
                "default pattern must not be blank"
            );
            assert!(
                seen.insert(pattern.to_ascii_lowercase()),
                "duplicate {pattern}"
            );
        }
    }

    #[test]
    fn defaults_do_not_use_broad_google_api_wildcards() {
        let patterns = default_ssl_proxying_exclusions();
        for broad_pattern in [
            "*.googleapis.com",
            "*.gstatic.com",
            "*.googleusercontent.com",
        ] {
            assert!(
                !patterns.iter().any(|pattern| pattern == broad_pattern),
                "{broad_pattern} would hide unrelated API traffic"
            );
        }
    }
}
