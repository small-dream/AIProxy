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

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::host_pattern::matches_any;
use crate::ssl_proxying_defaults::DEFAULT_SSL_PROXYING_EXCLUSIONS;

/// A resolved SSL proxying policy, consulted once per CONNECT.
#[derive(Debug, Clone)]
pub struct SslProxyingConfig {
    /// When non-empty, only matching hosts are decrypted. Empty means "decrypt
    /// everything that is not excluded".
    pub include: Arc<[String]>,
    /// Hosts never decrypted, regardless of `include`.
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
        if matches_any(&self.exclude, host) {
            return false;
        }
        if self.include.is_empty() {
            return true;
        }
        matches_any(&self.include, host)
    }
}

/// Persisted / IPC form of the SSL proxying settings.
///
/// Distinct from [`SslProxyingConfig`] for the same reason the upstream proxy
/// splits its two types: this is the serializable shape the DB column and the
/// frontend exchange, while the config is the runtime value the server holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslProxyingSettings {
    /// Empty means "intercept everything not excluded", which preserves the
    /// behavior of every workspace created before this setting existed.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Default for SslProxyingSettings {
    fn default() -> Self {
        Self {
            include: Vec::new(),
            exclude: DEFAULT_SSL_PROXYING_EXCLUSIONS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        }
    }
}

impl SslProxyingSettings {
    /// Convert to the runtime policy, dropping blank entries the textarea may
    /// have produced.
    pub fn to_runtime_config(&self) -> SslProxyingConfig {
        SslProxyingConfig {
            include: normalize(&self.include),
            exclude: normalize(&self.exclude),
        }
    }
}

fn normalize(patterns: &[String]) -> Arc<[String]> {
    Arc::from(
        patterns
            .iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>(),
    )
}
