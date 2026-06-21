use super::SystemProxySettings;
use serde::{Deserialize, Serialize};
use std::env;
use std::process::Command;

const PROXY_BYPASS_DOMAINS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
const GSETTINGS_PROXY_SCHEMA: &str = "org.gnome.system.proxy";

// ---------------------------------------------------------------------------
// Desktop environment detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
enum LinuxDesktopEnvironment {
    Gnome,
    Kde,
}

fn detect_desktop_environment() -> Result<LinuxDesktopEnvironment, String> {
    let xdg = env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let session = env::var("DESKTOP_SESSION")
        .unwrap_or_default()
        .to_ascii_lowercase();

    let combined = format!("{xdg}|{session}");

    if combined.contains("gnome")
        || combined.contains("ubuntu")
        || combined.contains("pop")
        || combined.contains("unity")
    {
        return Ok(LinuxDesktopEnvironment::Gnome);
    }

    if combined.contains("kde") || combined.contains("plasma") {
        return Ok(LinuxDesktopEnvironment::Kde);
    }

    Err(format!(
        "unsupported Linux desktop environment (XDG_CURRENT_DESKTOP={xdg:?}, DESKTOP_SESSION={session:?})"
    ))
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LinuxSystemProxySnapshot {
    desktop: LinuxDesktopEnvironment,
    gnome: Option<GnomeProxySnapshot>,
    kde: Option<KdeProxySnapshot>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GnomeProxySnapshot {
    mode: String,
    http_host: Option<String>,
    http_port: Option<u32>,
    https_host: Option<String>,
    https_port: Option<u32>,
    ignore_hosts: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct KdeProxySnapshot {
    proxy_type: Option<String>,
    http_proxy: Option<String>,
    https_proxy: Option<String>,
    no_proxy_for: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API — matches the trait expected by mod.rs
// ---------------------------------------------------------------------------

pub fn capture_system_proxy_snapshot() -> Result<LinuxSystemProxySnapshot, String> {
    let desktop = detect_desktop_environment()?;

    match desktop {
        LinuxDesktopEnvironment::Gnome => {
            let snapshot = capture_gnome_snapshot()?;
            tracing::debug!(
                component = "desktop.system_proxy.linux",
                event = "snapshot_captured",
                desktop = "gnome",
                "snapshot_captured"
            );
            Ok(LinuxSystemProxySnapshot {
                desktop,
                gnome: Some(snapshot),
                kde: None,
            })
        }
        LinuxDesktopEnvironment::Kde => {
            let snapshot = capture_kde_snapshot()?;
            tracing::debug!(
                component = "desktop.system_proxy.linux",
                event = "snapshot_captured",
                desktop = "kde",
                "snapshot_captured"
            );
            Ok(LinuxSystemProxySnapshot {
                desktop,
                gnome: None,
                kde: Some(snapshot),
            })
        }
    }
}

pub fn apply_system_proxy_settings(settings: &SystemProxySettings) -> Result<(), String> {
    let snapshot = capture_system_proxy_snapshot()?;
    apply_system_proxy_settings_with_pre_snapshot(settings, snapshot)
}

pub fn apply_system_proxy_settings_with_pre_snapshot(
    settings: &SystemProxySettings,
    snapshot: LinuxSystemProxySnapshot,
) -> Result<(), String> {
    match snapshot.desktop {
        LinuxDesktopEnvironment::Gnome => apply_gnome_proxy(settings, snapshot.gnome.as_ref()),
        LinuxDesktopEnvironment::Kde => apply_kde_proxy(settings, snapshot.kde.as_ref()),
    }
}

pub fn restore_system_proxy(snapshot: &LinuxSystemProxySnapshot) -> Result<(), String> {
    match snapshot.desktop {
        LinuxDesktopEnvironment::Gnome => restore_gnome(snapshot.gnome.as_ref()),
        LinuxDesktopEnvironment::Kde => restore_kde(snapshot.kde.as_ref()),
    }
}

// ---------------------------------------------------------------------------
// GNOME implementation (gsettings)
// ---------------------------------------------------------------------------

fn capture_gnome_snapshot() -> Result<GnomeProxySnapshot, String> {
    Ok(GnomeProxySnapshot {
        mode: gsettings_get("mode"),
        http_host: gsettings_get_optional("http", "host"),
        http_port: gsettings_get_optional_u32("http", "port"),
        https_host: gsettings_get_optional("https", "host"),
        https_port: gsettings_get_optional_u32("https", "port"),
        ignore_hosts: gsettings_get_list("ignore-hosts"),
    })
}

fn apply_gnome_proxy(
    settings: &SystemProxySettings,
    _snapshot: Option<&GnomeProxySnapshot>,
) -> Result<(), String> {
    let port_str = settings.port.to_string();

    gsettings_set("http", "host", &settings.host)?;
    gsettings_set("http", "port", &port_str)?;
    gsettings_set("https", "host", &settings.host)?;
    gsettings_set("https", "port", &port_str)?;
    gsettings_set_ignore_hosts(&PROXY_BYPASS_DOMAINS)?;
    gsettings_set_value("mode", "'manual'")?;

    tracing::info!(
        component = "desktop.system_proxy.linux",
        event = "proxy_settings_applied",
        desktop = "gnome",
        endpoint = %settings.endpoint(),
        "proxy_settings_applied"
    );

    Ok(())
}

fn restore_gnome(snapshot: Option<&GnomeProxySnapshot>) -> Result<(), String> {
    let snapshot = snapshot.ok_or_else(|| "missing GNOME snapshot".to_string())?;

    let mut errors = Vec::new();

    if let Err(e) = gsettings_set_value("mode", &snapshot.mode) {
        errors.push(format!("restore mode: {e}"));
    }

    if let Some(ref host) = snapshot.http_host {
        if let Err(e) = gsettings_set("http", "host", host) {
            errors.push(format!("restore http host: {e}"));
        }
    }
    if let Some(port) = snapshot.http_port {
        if let Err(e) = gsettings_set("http", "port", &port.to_string()) {
            errors.push(format!("restore http port: {e}"));
        }
    }
    if let Some(ref host) = snapshot.https_host {
        if let Err(e) = gsettings_set("https", "host", host) {
            errors.push(format!("restore https host: {e}"));
        }
    }
    if let Some(port) = snapshot.https_port {
        if let Err(e) = gsettings_set("https", "port", &port.to_string()) {
            errors.push(format!("restore https port: {e}"));
        }
    }
    if let Err(e) = gsettings_set_ignore_hosts(&snapshot.ignore_hosts) {
        errors.push(format!("restore ignore-hosts: {e}"));
    }

    if !errors.is_empty() {
        return Err(format!(
            "failed to restore GNOME proxy: {}",
            errors.join(", ")
        ));
    }

    tracing::info!(
        component = "desktop.system_proxy.linux",
        event = "proxy_settings_restored",
        desktop = "gnome",
        "proxy_settings_restored"
    );

    Ok(())
}

fn gsettings_get(child_schema: &str, key: &str) -> String {
    let schema = format!("{GSETTINGS_PROXY_SCHEMA}.{child_schema}");
    let output = Command::new("gsettings")
        .args(["get", &schema, key])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let val = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // Strip surrounding single quotes from gsettings output.
            val.strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
                .map(str::to_string)
                .unwrap_or(val)
        }
        _ => "'none'".to_string(),
    }
}

fn gsettings_get_optional(child_schema: &str, key: &str) -> Option<String> {
    let val = gsettings_get(child_schema, key);
    if val.is_empty() || val == "''" || val == "'none'" {
        None
    } else {
        Some(val)
    }
}

fn gsettings_get_optional_u32(child_schema: &str, key: &str) -> Option<u32> {
    let val = gsettings_get(child_schema, key);
    val.parse::<u32>().ok().filter(|&p| p != 0)
}

fn gsettings_get_list(key: &str) -> Vec<String> {
    let output = Command::new("gsettings")
        .args(["get", GSETTINGS_PROXY_SCHEMA, key])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let raw = String::from_utf8_lossy(&o.stdout).trim().to_string();
            parse_gsettings_array(&raw)
        }
        _ => Vec::new(),
    }
}

fn gsettings_set(child_schema: &str, key: &str, value: &str) -> Result<(), String> {
    let schema = format!("{GSETTINGS_PROXY_SCHEMA}.{child_schema}");
    let output = Command::new("gsettings")
        .args(["set", &schema, key, value])
        .output()
        .map_err(|e| format!("gsettings set {schema} {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("gsettings set {schema} {key} failed: {stderr}"));
    }

    Ok(())
}

fn gsettings_set_value(key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("gsettings")
        .args(["set", GSETTINGS_PROXY_SCHEMA, key, value])
        .output()
        .map_err(|e| format!("gsettings set {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("gsettings set {key} failed: {stderr}"));
    }

    Ok(())
}

fn gsettings_set_ignore_hosts(domains: &[&str]) -> Result<(), String> {
    // Build a GVariant array string: "['localhost', '127.0.0.1', '::1']"
    let items: Vec<String> = domains.iter().map(|d| format!("'{d}'")).collect();
    let value = format!("[{}]", items.join(", "));
    gsettings_set_value("ignore-hosts", &value)
}

fn parse_gsettings_array(raw: &str) -> Vec<String> {
    // GVariant array format: "['item1', 'item2']" or "@as []"
    if !raw.starts_with('[') {
        return Vec::new();
    }

    let inner = raw.trim_start_matches('[').trim_end_matches(']').trim();

    if inner.is_empty() {
        return Vec::new();
    }

    inner
        .split(',')
        .map(|item| {
            item.trim()
                .trim_start_matches('\'')
                .trim_end_matches('\'')
                .to_string()
        })
        .filter(|item| !item.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// KDE implementation (kwriteconfig6)
// ---------------------------------------------------------------------------

fn capture_kde_snapshot() -> Result<KdeProxySnapshot, String> {
    Ok(KdeProxySnapshot {
        proxy_type: kread_config("ProxyType"),
        http_proxy: kread_config("httpProxy"),
        https_proxy: kread_config("httpsProxy"),
        no_proxy_for: kread_config("NoProxyFor"),
    })
}

fn apply_kde_proxy(
    settings: &SystemProxySettings,
    _snapshot: Option<&KdeProxySnapshot>,
) -> Result<(), String> {
    let endpoint = settings.endpoint();

    kwrite_config("ProxyType", "1")?; // 1 = manual
    kwrite_config("httpProxy", &endpoint)?;
    kwrite_config("httpsProxy", &endpoint)?;
    kwrite_config("NoProxyFor", &PROXY_BYPASS_DOMAINS.join(","))?;

    tracing::info!(
        component = "desktop.system_proxy.linux",
        event = "proxy_settings_applied",
        desktop = "kde",
        endpoint = %settings.endpoint(),
        "proxy_settings_applied"
    );

    Ok(())
}

fn restore_kde(snapshot: Option<&KdeProxySnapshot>) -> Result<(), String> {
    let snapshot = snapshot.ok_or_else(|| "missing KDE snapshot".to_string())?;

    let mut errors = Vec::new();

    // For each key: if the snapshot captured a value, write it back; if it was
    // None (the key had no value before apply), DELETE the key so the value
    // apply_kde_proxy wrote does not leak into the user's config after they
    // disable the system proxy. This applies to all four keys, not just
    // httpsProxy (H2 residual — previously None left the apply-written value
    // in place).
    let keys: [(&str, &Option<String>); 4] = [
        ("ProxyType", &snapshot.proxy_type),
        ("httpProxy", &snapshot.http_proxy),
        ("httpsProxy", &snapshot.https_proxy),
        ("NoProxyFor", &snapshot.no_proxy_for),
    ];
    for (key, value) in keys {
        let result = match value {
            Some(val) => kwrite_config(key, val),
            None => kdelete_config(key),
        };
        if let Err(e) = result {
            errors.push(format!("restore {key}: {e}"));
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "failed to restore KDE proxy: {}",
            errors.join(", ")
        ));
    }

    tracing::info!(
        component = "desktop.system_proxy.linux",
        event = "proxy_settings_restored",
        desktop = "kde",
        "proxy_settings_restored"
    );

    Ok(())
}

fn kwrite_config(key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("kwriteconfig6")
        .args([
            "--file",
            "kioslaverc",
            "--group",
            "Proxy Settings",
            "--key",
            key,
            value,
        ])
        .output()
        .map_err(|e| format!("kwriteconfig6 {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("kwriteconfig6 {key} failed: {stderr}"));
    }

    Ok(())
}

/// Delete a KDE config key (kwriteconfig6 --delete). Used during restore when
/// the captured snapshot was `None` (the key had no value before apply), so the
/// value apply_kde_proxy wrote does not leak into the user's config after they
/// disable the system proxy (H2 residual).
fn kdelete_config(key: &str) -> Result<(), String> {
    let output = Command::new("kwriteconfig6")
        .args([
            "--file",
            "kioslaverc",
            "--group",
            "Proxy Settings",
            "--key",
            key,
            "--delete",
        ])
        .output()
        .map_err(|e| format!("kwriteconfig6 --delete {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("kwriteconfig6 --delete {key} failed: {stderr}"));
    }

    Ok(())
}

fn kread_config(key: &str) -> Option<String> {
    let output = Command::new("kreadconfig6")
        .args([
            "--file",
            "kioslaverc",
            "--group",
            "Proxy Settings",
            "--key",
            key,
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let val = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if val.is_empty() {
                None
            } else {
                Some(val)
            }
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_gvariant_array() {
        assert_eq!(parse_gsettings_array("[]"), Vec::<String>::new());
    }

    #[test]
    fn parses_empty_gvariant_as() {
        assert_eq!(parse_gsettings_array("@as []"), Vec::<String>::new());
    }

    #[test]
    fn parses_gvariant_array_with_items() {
        let result = parse_gsettings_array("['localhost', '127.0.0.1', '::1']");
        assert_eq!(result, vec!["localhost", "127.0.0.1", "::1"]);
    }

    #[test]
    fn detects_gnome_from_xdg() {
        env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
        env::set_var("DESKTOP_SESSION", "gnome");
        assert_eq!(
            detect_desktop_environment().unwrap(),
            LinuxDesktopEnvironment::Gnome
        );
    }

    #[test]
    fn detects_kde_from_xdg() {
        env::set_var("XDG_CURRENT_DESKTOP", "KDE");
        env::set_var("DESKTOP_SESSION", "plasma");
        assert_eq!(
            detect_desktop_environment().unwrap(),
            LinuxDesktopEnvironment::Kde
        );
    }

    #[test]
    fn detects_ubuntu_as_gnome() {
        env::set_var("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
        env::set_var("DESKTOP_SESSION", "ubuntu");
        assert_eq!(
            detect_desktop_environment().unwrap(),
            LinuxDesktopEnvironment::Gnome
        );
    }

    #[test]
    fn rejects_unknown_desktop() {
        env::set_var("XDG_CURRENT_DESKTOP", "sway");
        env::set_var("DESKTOP_SESSION", "sway");
        assert!(detect_desktop_environment().is_err());
    }
}
