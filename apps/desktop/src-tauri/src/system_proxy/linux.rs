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

fn detect_desktop_environment_from(
    xdg_current_desktop: &str,
    desktop_session: &str,
) -> Result<LinuxDesktopEnvironment, String> {
    let xdg = xdg_current_desktop.to_ascii_lowercase();
    let session = desktop_session.to_ascii_lowercase();

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

fn detect_desktop_environment() -> Result<LinuxDesktopEnvironment, String> {
    detect_desktop_environment_from(
        &env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
        &env::var("DESKTOP_SESSION").unwrap_or_default(),
    )
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
    // M13: capture the rest of the GNOME proxy schema so restore is faithful.
    // `apply` does NOT touch these keys (it only sets http/https/mode/ignore-
    // hosts), so the user's pre-existing socks/ftp/use-same-proxy settings are
    // preserved while the proxy is enabled; restore writes them back from the
    // snapshot to undo any drift caused by other tools during the session.
    ftp_host: Option<String>,
    ftp_port: Option<u32>,
    socks_host: Option<String>,
    socks_port: Option<u32>,
    use_same_proxy: Option<bool>,
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

/// Apply `settings`, rolling back to `snapshot` when any step fails.
///
/// Both desktop backends write the proxy in several independent calls (GNOME:
/// mode + per-protocol host/port + ignore-hosts; KDE: ProxyType + per-protocol
/// keys). A failure in the middle therefore leaves a mix of old and new values,
/// and the caller does not register the in-memory snapshot when this returns
/// `Err` — so without an explicit rollback the rest of the session has no way to
/// restore the user's original configuration and the machine keeps pointing at
/// a proxy that is not fully configured. Windows and macOS already roll back in
/// this situation; mirror them and surface both errors.
pub fn apply_system_proxy_settings_with_pre_snapshot(
    settings: &SystemProxySettings,
    snapshot: LinuxSystemProxySnapshot,
) -> Result<(), String> {
    let apply_result = match snapshot.desktop {
        LinuxDesktopEnvironment::Gnome => apply_gnome_proxy(settings, snapshot.gnome.as_ref()),
        LinuxDesktopEnvironment::Kde => apply_kde_proxy(settings, snapshot.kde.as_ref()),
    };

    match apply_result {
        Ok(()) => Ok(()),
        Err(error) => Err(match restore_system_proxy(&snapshot) {
            Ok(()) => error,
            Err(rollback) => format!("{error}; rollback also failed: {rollback}"),
        }),
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
        mode: gsettings_get_value("mode")?,
        http_host: gsettings_get_optional("http", "host")?,
        http_port: gsettings_get_optional_u32("http", "port")?,
        https_host: gsettings_get_optional("https", "host")?,
        https_port: gsettings_get_optional_u32("https", "port")?,
        ignore_hosts: gsettings_get_list("ignore-hosts")?,
        // M13: capture the rest of the schema (ftp, socks, use-same-proxy).
        ftp_host: gsettings_get_optional("ftp", "host")?,
        ftp_port: gsettings_get_optional_u32("ftp", "port")?,
        socks_host: gsettings_get_optional("socks", "host")?,
        socks_port: gsettings_get_optional_u32("socks", "port")?,
        use_same_proxy: gsettings_get_optional_bool("use-same-proxy")?,
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

    // P1-6: restore EVERY protocol slot, including the ones that were empty
    // before AIProxy took over. The previous `if let Some(...)` skipped them,
    // so a user who had only http (https empty) ended up with https still
    // pointing at the AIProxy port after "disable system proxy" — the mode was
    // restored to `manual`, the recovery file was deleted, and the dead-port
    // black hole became permanent. Empty host + port 0 is GNOME's "unset".
    let http_host = restore_host(snapshot.http_host.as_deref());
    if let Err(e) = gsettings_set("http", "host", http_host) {
        errors.push(format!("restore http host: {e}"));
    }
    if let Err(e) = gsettings_set("http", "port", &restore_port(snapshot.http_port)) {
        errors.push(format!("restore http port: {e}"));
    }
    let https_host = restore_host(snapshot.https_host.as_deref());
    if let Err(e) = gsettings_set("https", "host", https_host) {
        errors.push(format!("restore https host: {e}"));
    }
    if let Err(e) = gsettings_set("https", "port", &restore_port(snapshot.https_port)) {
        errors.push(format!("restore https port: {e}"));
    }
    let ignore_refs: Vec<&str> = snapshot.ignore_hosts.iter().map(String::as_str).collect();
    if let Err(e) = gsettings_set_ignore_hosts(&ignore_refs) {
        errors.push(format!("restore ignore-hosts: {e}"));
    }

    // M13: restore the rest of the GNOME proxy schema (ftp, socks,
    // use-same-proxy). `apply` did not touch these, so restoring them mostly
    // no-ops unless another tool changed them while the proxy was enabled.
    // Restoring keeps the snapshot faithful: a captured `mode='manual'` with
    // pre-existing socks/ftp entries reactivates those entries on restore.
    let ftp_host = restore_host(snapshot.ftp_host.as_deref());
    if let Err(e) = gsettings_set("ftp", "host", ftp_host) {
        errors.push(format!("restore ftp host: {e}"));
    }
    if let Err(e) = gsettings_set("ftp", "port", &restore_port(snapshot.ftp_port)) {
        errors.push(format!("restore ftp port: {e}"));
    }
    let socks_host = restore_host(snapshot.socks_host.as_deref());
    if let Err(e) = gsettings_set("socks", "host", socks_host) {
        errors.push(format!("restore socks host: {e}"));
    }
    if let Err(e) = gsettings_set("socks", "port", &restore_port(snapshot.socks_port)) {
        errors.push(format!("restore socks port: {e}"));
    }
    if let Some(value) = snapshot.use_same_proxy {
        if let Err(e) = gsettings_set_value("use-same-proxy", if value { "true" } else { "false" })
        {
            errors.push(format!("restore use-same-proxy: {e}"));
        }
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

/// Port argument for a restore. `None` means the key was empty at capture time
/// (GNOME's "unset") and must be written back as 0; skipping it would leave the
/// AIProxy port behind (P1-6).
fn restore_port(port: Option<u32>) -> String {
    port.unwrap_or(0).to_string()
}

/// Host argument for a restore. Empty slots must be actively cleared with an
/// empty value; skipping the write leaves AIProxy's host behind (P1-6).
fn restore_host(host: Option<&str>) -> &str {
    match host {
        Some(value) if !value.is_empty() => value,
        _ => "",
    }
}

/// Read one child-schema key. A failed `gsettings` invocation is an error, NOT
/// an empty value: the caller must abort capture instead of writing a bogus
/// snapshot (P1-6 — an empty snapshot is now restored as "clear this key", so a
/// swallowed read failure would erase the user's configuration).
fn gsettings_get(child_schema: &str, key: &str) -> Result<String, String> {
    let schema = format!("{GSETTINGS_PROXY_SCHEMA}.{child_schema}");
    let output = Command::new("gsettings")
        .args(["get", &schema, key])
        .output()
        .map_err(|e| format!("gsettings get {schema} {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("gsettings get {schema} {key} failed: {stderr}"));
    }

    Ok(strip_gsettings_quotes(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

/// `None` means the key holds an empty string (GNOME's "unset" value) and the
/// snapshot must restore exactly that. Read failures are returned as `Err`.
fn gsettings_get_optional(child_schema: &str, key: &str) -> Result<Option<String>, String> {
    let val = gsettings_get(child_schema, key)?;
    if val.is_empty() {
        Ok(None)
    } else {
        Ok(Some(val))
    }
}

fn gsettings_get_optional_u32(child_schema: &str, key: &str) -> Result<Option<u32>, String> {
    let val = gsettings_get(child_schema, key)?;
    if val.is_empty() {
        return Ok(None);
    }
    let port = val.parse::<u32>().map_err(|error| {
        format!(
            "gsettings returned a non-numeric value for {child_schema}.{key}: {val:?} ({error})"
        )
    })?;
    Ok((port != 0).then_some(port))
}

/// M13: read a top-level boolean key (e.g. `use-same-proxy`) directly from the
/// root GNOME proxy schema `org.gnome.system.proxy`. gsettings prints booleans
/// as `true`/`false`; any other value means the schema/read is broken and must
/// fail capture rather than silently produce a partial snapshot.
fn gsettings_get_optional_bool(key: &str) -> Result<Option<bool>, String> {
    let val = gsettings_get_root(key)?;
    match val.as_str() {
        "true" => Ok(Some(true)),
        "false" => Ok(Some(false)),
        "" => Ok(None),
        other => Err(format!(
            "gsettings returned a non-boolean value for {key}: {other:?}"
        )),
    }
}

fn gsettings_get_list(key: &str) -> Result<Vec<String>, String> {
    Ok(parse_gsettings_array(&gsettings_get_root(key)?))
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

/// Read a top-level key exactly as gsettings prints it (quotes/array syntax
/// preserved).
fn gsettings_get_root(key: &str) -> Result<String, String> {
    let output = Command::new("gsettings")
        .args(["get", GSETTINGS_PROXY_SCHEMA, key])
        .output()
        .map_err(|e| format!("gsettings get {key}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("gsettings get {key} failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn gsettings_get_value(key: &str) -> Result<String, String> {
    Ok(strip_gsettings_quotes(&gsettings_get_root(key)?))
}

/// gsettings prints string values as `'value'`; strip the surrounding single
/// quotes so the snapshot stores the logical value.
fn strip_gsettings_quotes(raw: &str) -> String {
    raw.strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .map(str::to_string)
        .unwrap_or_else(|| raw.to_string())
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
    fn restore_port_clears_missing_slots() {
        // P1-6: an empty pre-AIProxy port must be written as 0 (GNOME's unset
        // value), not skipped, otherwise the AIProxy port survives disable.
        assert_eq!(restore_port(None), "0");
        assert_eq!(restore_port(Some(8888)), "8888");
    }

    #[test]
    fn restore_host_clears_missing_slots() {
        // P1-6: an empty pre-AIProxy host must be written back as an empty
        // string, not skipped.
        assert_eq!(restore_host(None), "");
        assert_eq!(restore_host(Some("")), "");
        assert_eq!(restore_host(Some("127.0.0.1")), "127.0.0.1");
    }

    #[test]
    fn strips_gsettings_string_quotes() {
        assert_eq!(strip_gsettings_quotes("'manual'"), "manual");
        assert_eq!(strip_gsettings_quotes("''"), "");
        assert_eq!(strip_gsettings_quotes("[ 'a' ]"), "[ 'a' ]");
    }

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
        assert_eq!(
            detect_desktop_environment_from("GNOME", "gnome").unwrap(),
            LinuxDesktopEnvironment::Gnome
        );
    }

    #[test]
    fn detects_kde_from_xdg() {
        assert_eq!(
            detect_desktop_environment_from("KDE", "plasma").unwrap(),
            LinuxDesktopEnvironment::Kde
        );
    }

    #[test]
    fn detects_ubuntu_as_gnome() {
        assert_eq!(
            detect_desktop_environment_from("ubuntu:GNOME", "ubuntu").unwrap(),
            LinuxDesktopEnvironment::Gnome
        );
    }

    #[test]
    fn rejects_unknown_desktop() {
        assert!(detect_desktop_environment_from("sway", "sway").is_err());
    }

    // M13: the GNOME snapshot must capture (and serde-round-trip) the full
    // proxy schema — ftp/socks host+port and use-same-proxy — so restore is
    // faithful. `apply` does not touch these keys, but capturing + restoring
    // them keeps the snapshot complete (a `mode='manual'` with pre-existing
    // socks/ftp entries reactivates those entries on restore).
    #[test]
    fn gnome_snapshot_round_trips_full_schema() {
        let snapshot = GnomeProxySnapshot {
            mode: "'manual'".to_string(),
            http_host: Some("127.0.0.1".to_string()),
            http_port: Some(8888),
            https_host: Some("127.0.0.1".to_string()),
            https_port: Some(8888),
            ignore_hosts: vec!["localhost".to_string(), "127.0.0.1".to_string()],
            ftp_host: Some("socks.example".to_string()),
            ftp_port: Some(1080),
            socks_host: Some("socks.example".to_string()),
            socks_port: Some(1080),
            use_same_proxy: Some(true),
        };
        let json = serde_json::to_string(&snapshot).expect("snapshot serializes");
        let restored: GnomeProxySnapshot =
            serde_json::from_str(&json).expect("snapshot deserializes");

        assert_eq!(restored.ftp_host.as_deref(), Some("socks.example"));
        assert_eq!(restored.ftp_port, Some(1080));
        assert_eq!(restored.socks_host.as_deref(), Some("socks.example"));
        assert_eq!(restored.socks_port, Some(1080));
        assert_eq!(restored.use_same_proxy, Some(true));
    }
}
