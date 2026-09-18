//! Per-host SSL proxying policy.
//!
//! TLS interception is only useful when the client trusts our certificate.
//! Apps that pin a certificate reject it by design, and because a rejected
//! handshake kills the connection, intercepting them does not merely fail to
//! decrypt — it breaks the app outright.
//!
//! This module decides, per host, whether a CONNECT tunnel is decrypted or
//! relayed blind. It mirrors Charles' "SSL Proxying Settings": an include list
//! that scopes interception and an exclude list that always wins.
//!
//! Beyond the two lists, each entry carries its own enable switch and each
//! list has a master switch, so a user can keep patterns around but toggle
//! them without deleting and re-adding. The include list only takes effect
//! when its master switch is on (allowlist mode); otherwise everything not
//! excluded is decrypted.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::host_pattern::matches_any;
use crate::ssl_proxying_defaults::DEFAULT_SSL_PROXYING_EXCLUSIONS;

/// A resolved SSL proxying policy, consulted once per CONNECT.
#[derive(Debug, Clone)]
pub struct SslProxyingConfig {
    /// Master switch for the include list. When on, only hosts matching an
    /// enabled include pattern are decrypted.
    pub include_enabled: bool,
    /// Master switch for the exclude list. When on, excluded hosts are relayed
    /// blind regardless of anything else.
    pub exclude_enabled: bool,
    /// Enabled include patterns. Empty when `include_enabled` is off or when
    /// no enabled entries exist.
    pub include: Arc<[String]>,
    /// Enabled exclude patterns. Empty when `exclude_enabled` is off or when
    /// no enabled entries exist.
    pub exclude: Arc<[String]>,
}

impl Default for SslProxyingConfig {
    /// Mirrors [`SslProxyingSettings::default`] so "unconfigured" means the
    /// same thing at every layer — most importantly the built-in exclusions
    /// for known-pinning hosts. A derived empty/empty default would silently
    /// intercept those and break the apps this policy exists to protect.
    fn default() -> Self {
        SslProxyingSettings::default().to_runtime_config()
    }
}

impl SslProxyingConfig {
    /// Whether `host` should be MITM'd. A `false` verdict sends the connection
    /// down the blind-relay path, which keeps the app working at the cost of
    /// not seeing its plaintext.
    pub fn should_intercept(&self, host: &str) -> bool {
        // Exclude wins: it is the escape hatch users reach for when an app
        // breaks, and it must not be defeated by a broad include pattern.
        if self.exclude_enabled && matches_any(&self.exclude, host) {
            return false;
        }
        // Include only restricts once its master switch is on; otherwise the
        // default posture (decrypt everything not excluded) applies.
        if self.include_enabled {
            return matches_any(&self.include, host);
        }
        true
    }
}

/// A single SSL proxying rule: a host pattern plus an enable switch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslProxyEntry {
    pub pattern: String,
    pub enabled: bool,
}

/// Persisted / IPC form of the SSL proxying settings.
///
/// Distinct from [`SslProxyingConfig`] for the same reason the upstream proxy
/// splits its two types: this is the serializable shape the DB column and the
/// frontend exchange, while the config is the runtime value the server holds.
///
/// `Deserialize` is implemented by hand to migrate the legacy shape (plain
/// `string[]` lists) into the entry form, so a workspace saved before the
/// per-entry switches existed keeps behaving the same after the upgrade.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SslProxyingSettings {
    /// Master switch for the include list; off means "decrypt everything not
    /// excluded", preserving the pre-switch behavior of empty include lists.
    pub include_enabled: bool,
    /// Master switch for the exclude list; defaults on because the list is the
    /// escape hatch for pinning clients.
    pub exclude_enabled: bool,
    /// Rules deciding which hosts get decrypted in allowlist mode.
    pub include: Vec<SslProxyEntry>,
    /// Rules for hosts that are never decrypted.
    pub exclude: Vec<SslProxyEntry>,
}

impl Default for SslProxyingSettings {
    fn default() -> Self {
        Self {
            include_enabled: false,
            exclude_enabled: true,
            include: Vec::new(),
            exclude: DEFAULT_SSL_PROXYING_EXCLUSIONS
                .iter()
                .map(|pattern| SslProxyEntry {
                    pattern: (*pattern).to_string(),
                    enabled: true,
                })
                .collect(),
        }
    }
}

impl<'de> Deserialize<'de> for SslProxyingSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct New {
            // Every field defaults so a persisted payload missing some fields
            // (e.g. written by an older/newer build with a different field
            // set) still partially parses instead of failing wholesale.
            #[serde(default)]
            include_enabled: bool,
            #[serde(default)]
            exclude_enabled: bool,
            #[serde(default)]
            include: Vec<SslProxyEntry>,
            #[serde(default)]
            exclude: Vec<SslProxyEntry>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Legacy {
            #[serde(default)]
            include: Vec<String>,
            #[serde(default)]
            exclude: Vec<String>,
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            New(New),
            Legacy(Legacy),
        }

        match Repr::deserialize(deserializer)? {
            Repr::New(settings) => Ok(Self {
                include_enabled: settings.include_enabled,
                exclude_enabled: settings.exclude_enabled,
                include: settings.include,
                exclude: settings.exclude,
            }),
            Repr::Legacy(settings) => Ok(Self {
                // A legacy include list that is non-empty was an allowlist.
                include_enabled: !settings.include.is_empty(),
                // The legacy exclude list was always in effect.
                exclude_enabled: true,
                include: settings
                    .include
                    .into_iter()
                    .map(|pattern| SslProxyEntry {
                        pattern,
                        enabled: true,
                    })
                    .collect(),
                exclude: settings
                    .exclude
                    .into_iter()
                    .map(|pattern| SslProxyEntry {
                        pattern,
                        enabled: true,
                    })
                    .collect(),
            }),
        }
    }
}

impl SslProxyingSettings {
    /// Convert to the runtime policy, keeping only enabled, non-blank entries
    /// (a text input may have produced blank lines).
    pub fn to_runtime_config(&self) -> SslProxyingConfig {
        SslProxyingConfig {
            include_enabled: self.include_enabled,
            exclude_enabled: self.exclude_enabled,
            include: enabled_patterns(&self.include),
            exclude: enabled_patterns(&self.exclude),
        }
    }
}

fn enabled_patterns(entries: &[SslProxyEntry]) -> Arc<[String]> {
    Arc::from(
        entries
            .iter()
            .filter(|entry| entry.enabled)
            .map(|entry| entry.pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // The legacy shape (plain string lists) must still deserialize and migrate
    // to the entry form, unaffected by the new field defaults.
    #[test]
    fn legacy_string_list_shape_still_deserializes() {
        let settings: SslProxyingSettings = serde_json::from_str(
            r#"{"include":["*.example.com"],"exclude":["pinned.example"]}"#,
        )
        .expect("legacy shape must parse");

        assert!(settings.include_enabled);
        assert!(settings.exclude_enabled);
        assert_eq!(settings.include.len(), 1);
        assert_eq!(settings.include[0].pattern, "*.example.com");
        assert!(settings.include[0].enabled);
        assert_eq!(settings.exclude.len(), 1);
        assert_eq!(settings.exclude[0].pattern, "pinned.example");
        assert!(settings.exclude[0].enabled);
    }

    // Regression: a new-shape payload missing some fields must partially
    // parse (missing fields fall back to their Rust defaults) instead of
    // failing the whole settings blob.
    #[test]
    fn new_shape_with_missing_fields_partially_deserializes() {
        let settings: SslProxyingSettings = serde_json::from_str(r#"{"includeEnabled":true}"#)
            .expect("partial new shape must parse");

        assert!(settings.include_enabled);
        assert!(!settings.exclude_enabled);
        assert!(settings.include.is_empty());
        assert!(settings.exclude.is_empty());
    }

    #[test]
    fn new_shape_missing_lists_keeps_flags() {
        let settings: SslProxyingSettings = serde_json::from_str(
            r#"{"includeEnabled":true,"excludeEnabled":false}"#,
        )
        .expect("partial new shape must parse");

        assert!(settings.include_enabled);
        assert!(!settings.exclude_enabled);
        assert!(settings.include.is_empty());
        assert!(settings.exclude.is_empty());
    }

    // The full new shape still round-trips unchanged.
    #[test]
    fn full_new_shape_round_trips() {
        let settings = SslProxyingSettings::default();
        let text = serde_json::to_string(&settings).expect("serialize");
        let parsed: SslProxyingSettings = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed, settings);
    }
}
