//! Host pattern matching shared by the features that scope behavior to a
//! subset of hosts: upstream-proxy bypass lists and SSL proxying include /
//! exclude lists.
//!
//! The syntax deliberately mirrors what system proxy bypass lists and Charles'
//! SSL Proxying settings accept, so patterns copied from either work unchanged.

use std::net::IpAddr;

/// Match `host` against a pattern list.
///
/// Supported pattern forms:
/// - `*` — match everything.
/// - `example.com` — exact hostname, case-insensitive.
/// - `2001:db8::5` — exact IPv6 literal; the bracketed spelling
///   (`[2001:db8::5]`) and a trailing FQDN dot are accepted on both sides.
/// - `*.example.com` / `.example.com` — the domain itself and any subdomain.
/// - `192.168.0.0/16` / `fd00::/8` — CIDR, matched only when the target is a
///   literal IP. Hostnames are never resolved to decide a match: doing so would
///   both add a blocking lookup to the hot path and defeat the point of letting
///   an upstream proxy own DNS.
///
/// An empty list never matches; callers decide what "no patterns" means for
/// their feature.
pub fn matches_any(patterns: &[String], host: &str) -> bool {
    let host = normalize_host_token(host);
    if host.is_empty() {
        return false;
    }
    let host_lower = host.to_ascii_lowercase();
    let host_ip = host_lower.parse::<IpAddr>().ok();

    patterns.iter().any(|pattern| {
        let pattern = normalize_host_token(pattern);
        if pattern.is_empty() {
            return false;
        }
        if pattern == "*" {
            return true;
        }
        let pattern_lower = pattern.to_ascii_lowercase();

        if let Some((network, prefix_len)) = pattern_lower.split_once('/') {
            // Only a literal-IP target can match a CIDR pattern.
            return match (host_ip, network.parse::<IpAddr>(), prefix_len.parse::<u8>()) {
                (Some(ip), Ok(network), Ok(prefix_len)) => ip_in_cidr(ip, network, prefix_len),
                _ => false,
            };
        }

        if let Some(suffix) = pattern_lower
            .strip_prefix("*.")
            .or_else(|| pattern_lower.strip_prefix('.'))
        {
            // `*.example.com` covers the apex too — that is what users mean,
            // and it matches how system proxy bypass lists behave.
            return host_lower == suffix || host_lower.ends_with(&format!(".{suffix}"));
        }

        host_lower == pattern_lower
    })
}

/// Normalize a host or pattern token before comparison: trim whitespace, strip
/// the brackets of an IPv6 literal, and drop a trailing FQDN dot.
///
/// Hosts arrive bracketed from URL authorities (`http::Uri::host()` and
/// `url::Url::host_str()` both keep `[...]`), while users and the built-in
/// pattern lists spell IPv6 addresses bare (`::1`). Comparing the normalized
/// form on both sides makes every spelling match; a bracketed *pattern*
/// (`[::1]`) is accepted for symmetry with copy-pasted authorities.
pub(crate) fn normalize_host_token(value: &str) -> &str {
    let trimmed = value.trim();
    let unbracketed = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    unbracketed.trim_end_matches('.')
}

/// Whether `ip` falls inside `network/prefix_len`. Mixed address families never
/// match (an IPv4 target is not inside an IPv6 network).
fn ip_in_cidr(ip: IpAddr, network: IpAddr, prefix_len: u8) -> bool {
    match (ip, network) {
        (IpAddr::V4(ip), IpAddr::V4(network)) => {
            if prefix_len > 32 {
                return false;
            }
            // Shifting by the full width is UB in Rust, so special-case /0.
            let mask = if prefix_len == 0 {
                0
            } else {
                u32::MAX << (32 - prefix_len)
            };
            u32::from(ip) & mask == u32::from(network) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(network)) => {
            if prefix_len > 128 {
                return false;
            }
            let mask = if prefix_len == 0 {
                0
            } else {
                u128::MAX << (128 - prefix_len)
            };
            u128::from(ip) & mask == u128::from(network) & mask
        }
        _ => false,
    }
}
