use super::SystemProxySettings;
use crate::dev_logger::{log_debug, log_error, log_info};
use std::path::Path;
use std::process::Command;

const NETWORKSETUP_PATH: &str = "/usr/sbin/networksetup";
const PROXY_BYPASS_DOMAINS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

#[derive(Debug, Clone)]
pub struct MacosSystemProxySnapshot {
    services: Vec<MacosNetworkServiceSnapshot>,
}

#[derive(Debug, Clone)]
struct MacosNetworkServiceSnapshot {
    auto_proxy_discovery_enabled: bool,
    auto_proxy_url: MacosAutoProxyUrlSnapshot,
    bypass_domains: Vec<String>,
    service_name: String,
    web_proxy: MacosProxyProtocolSnapshot,
    secure_web_proxy: MacosProxyProtocolSnapshot,
}

#[derive(Debug, Clone)]
struct MacosProxyProtocolSnapshot {
    enabled: bool,
    port: Option<u16>,
    server: Option<String>,
}

#[derive(Debug, Clone)]
struct MacosAutoProxyUrlSnapshot {
    enabled: bool,
    url: Option<String>,
}

pub fn capture_system_proxy_snapshot() -> Result<MacosSystemProxySnapshot, String> {
    let services = list_network_services()?
        .into_iter()
        .map(|service_name| {
            Ok(MacosNetworkServiceSnapshot {
                auto_proxy_discovery_enabled: get_auto_proxy_discovery_state(&service_name)?,
                auto_proxy_url: get_auto_proxy_url_snapshot(&service_name)?,
                bypass_domains: get_proxy_bypass_domains(&service_name)?,
                web_proxy: get_proxy_snapshot(&service_name, ProxyKind::Web)?,
                secure_web_proxy: get_proxy_snapshot(&service_name, ProxyKind::SecureWeb)?,
                service_name,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    log_debug(
        "desktop.system_proxy.macos",
        "snapshot_captured",
        &[("service_count", services.len().to_string())],
    );

    Ok(MacosSystemProxySnapshot { services })
}

pub fn apply_system_proxy_settings(settings: &SystemProxySettings) -> Result<(), String> {
    let snapshot = capture_system_proxy_snapshot()?;

    match apply_system_proxy_settings_with_snapshot(settings, &snapshot) {
        Ok(()) => {
            log_info(
                "desktop.system_proxy.macos",
                "proxy_settings_applied",
                &[("endpoint", settings.endpoint())],
            );
            Ok(())
        }
        Err(error) => {
            if let Err(restore_error) = restore_system_proxy(&snapshot) {
                log_error(
                    "desktop.system_proxy.macos",
                    "apply_rollback_failed",
                    &[("error", restore_error.clone())],
                );
                return Err(format!(
                    "{error}; rollback after failed apply also failed: {restore_error}"
                ));
            }

            Err(error)
        }
    }
}

pub fn restore_system_proxy(snapshot: &MacosSystemProxySnapshot) -> Result<(), String> {
    let mut failures = Vec::new();

    for service in &snapshot.services {
        if let Err(error) = restore_service_proxy_settings(service) {
            log_error(
                "desktop.system_proxy.macos",
                "service_restore_failed",
                &[
                    ("service_name", service.service_name.clone()),
                    ("error", error.clone()),
                ],
            );
            failures.push(format!("{}: {error}", service.service_name));
        }
    }

    if !failures.is_empty() {
        return Err(format!(
            "failed to restore macOS system proxy settings for {}",
            failures.join(", ")
        ));
    }

    log_info(
        "desktop.system_proxy.macos",
        "proxy_settings_restored",
        &[("service_count", snapshot.services.len().to_string())],
    );

    Ok(())
}

fn apply_system_proxy_settings_with_snapshot(
    settings: &SystemProxySettings,
    snapshot: &MacosSystemProxySnapshot,
) -> Result<(), String> {
    for service in &snapshot.services {
        set_proxy_bypass_domains(&service.service_name, &PROXY_BYPASS_DOMAINS)?;
        set_auto_proxy_discovery_state(&service.service_name, false)?;
        set_auto_proxy_url_state(&service.service_name, false)?;
        set_proxy_server(&service.service_name, ProxyKind::Web, settings)?;
        set_proxy_state(&service.service_name, ProxyKind::Web, true)?;
        set_proxy_server(&service.service_name, ProxyKind::SecureWeb, settings)?;
        set_proxy_state(&service.service_name, ProxyKind::SecureWeb, true)?;
    }

    Ok(())
}

fn restore_service_proxy_settings(service: &MacosNetworkServiceSnapshot) -> Result<(), String> {
    set_proxy_bypass_domains(&service.service_name, &service.bypass_domains)?;
    restore_auto_proxy_url_settings(&service.service_name, &service.auto_proxy_url)?;
    set_auto_proxy_discovery_state(
        &service.service_name,
        service.auto_proxy_discovery_enabled,
    )?;
    restore_protocol_proxy_settings(&service.service_name, ProxyKind::Web, &service.web_proxy)?;
    restore_protocol_proxy_settings(
        &service.service_name,
        ProxyKind::SecureWeb,
        &service.secure_web_proxy,
    )?;

    Ok(())
}

fn restore_protocol_proxy_settings(
    service_name: &str,
    kind: ProxyKind,
    snapshot: &MacosProxyProtocolSnapshot,
) -> Result<(), String> {
    if let (Some(server), Some(port)) = (snapshot.server.as_deref(), snapshot.port) {
        run_networksetup(kind.set_command(), &[service_name, server, &port.to_string()])?;
    } else if snapshot.enabled {
        return Err(format!(
            "captured macOS proxy settings for {service_name} are missing the {} server or port",
            kind.label()
        ));
    }

    set_proxy_state(service_name, kind, snapshot.enabled)
}

fn list_network_services() -> Result<Vec<String>, String> {
    let output = run_networksetup("-listallnetworkservices", &[])?;
    let services = parse_network_services(&output);

    if services.is_empty() {
        return Err("no macOS network services were detected".to_string());
    }

    Ok(services)
}

fn get_proxy_snapshot(
    service_name: &str,
    kind: ProxyKind,
) -> Result<MacosProxyProtocolSnapshot, String> {
    let output = run_networksetup(kind.get_command(), &[service_name])?;

    parse_proxy_snapshot(&output).ok_or_else(|| {
        format!(
            "failed to parse {} proxy settings for macOS network service {service_name}",
            kind.label()
        )
    })
}

fn get_proxy_bypass_domains(service_name: &str) -> Result<Vec<String>, String> {
    let output = run_networksetup("-getproxybypassdomains", &[service_name])?;
    Ok(parse_proxy_bypass_domains(&output))
}

fn get_auto_proxy_discovery_state(service_name: &str) -> Result<bool, String> {
    let output = run_networksetup("-getproxyautodiscovery", &[service_name])?;

    parse_auto_proxy_discovery_state(&output).ok_or_else(|| {
        format!(
            "failed to parse auto proxy discovery state for macOS network service {service_name}"
        )
    })
}

fn get_auto_proxy_url_snapshot(service_name: &str) -> Result<MacosAutoProxyUrlSnapshot, String> {
    let output = run_networksetup("-getautoproxyurl", &[service_name])?;

    parse_auto_proxy_url_snapshot(&output).ok_or_else(|| {
        format!("failed to parse auto proxy URL settings for macOS network service {service_name}")
    })
}

fn set_proxy_server(
    service_name: &str,
    kind: ProxyKind,
    settings: &SystemProxySettings,
) -> Result<(), String> {
    let port = settings.port.to_string();
    run_networksetup(kind.set_command(), &[service_name, &settings.host, &port]).map(|_| ())
}

fn set_proxy_state(service_name: &str, kind: ProxyKind, enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    run_networksetup(kind.state_command(), &[service_name, state]).map(|_| ())
}

fn set_proxy_bypass_domains(service_name: &str, domains: &[impl AsRef<str>]) -> Result<(), String> {
    let mut args = vec![service_name.to_string()];
    if domains.is_empty() {
        args.push("Empty".to_string());
    } else {
        args.extend(domains.iter().map(|domain| domain.as_ref().to_string()));
    }

    run_networksetup_with_owned_args("-setproxybypassdomains", args).map(|_| ())
}

fn set_auto_proxy_discovery_state(service_name: &str, enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    run_networksetup("-setproxyautodiscovery", &[service_name, state]).map(|_| ())
}

fn restore_auto_proxy_url_settings(
    service_name: &str,
    snapshot: &MacosAutoProxyUrlSnapshot,
) -> Result<(), String> {
    if let Some(url) = snapshot.url.as_deref() {
        run_networksetup("-setautoproxyurl", &[service_name, url])?;
        if !snapshot.enabled {
            set_auto_proxy_url_state(service_name, false)?;
        }
        return Ok(());
    }

    set_auto_proxy_url_state(service_name, false)
}

fn set_auto_proxy_url_state(service_name: &str, enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    run_networksetup("-setautoproxystate", &[service_name, state]).map(|_| ())
}

fn run_networksetup(command: &str, args: &[&str]) -> Result<String, String> {
    let executable = resolve_networksetup_path();
    let output = Command::new(executable)
        .arg(command)
        .args(args)
        .output()
        .map_err(|error| format!("failed to start networksetup {command}: {error}"))?;

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("networksetup {command} produced invalid UTF-8: {error}"));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", output.status)
    };

    Err(format!("networksetup {command} failed: {details}"))
}

fn run_networksetup_with_owned_args(command: &str, args: Vec<String>) -> Result<String, String> {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_networksetup(command, &borrowed)
}

fn resolve_networksetup_path() -> &'static str {
    if Path::new(NETWORKSETUP_PATH).exists() {
        NETWORKSETUP_PATH
    } else {
        "networksetup"
    }
}

fn parse_network_services(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("An asterisk"))
        .filter(|line| !line.starts_with('*'))
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_proxy_snapshot(output: &str) -> Option<MacosProxyProtocolSnapshot> {
    let mut enabled = None;
    let mut port = None;
    let mut server = None;

    for line in output.lines() {
        let trimmed = line.trim();

        if let Some(value) = trimmed.strip_prefix("Enabled:") {
            enabled = parse_yes_no(value.trim());
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Server:") {
            server = parse_optional_server(value.trim());
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Port:") {
            port = parse_optional_port(value.trim());
        }
    }

    Some(MacosProxyProtocolSnapshot {
        enabled: enabled?,
        port,
        server,
    })
}

fn parse_proxy_bypass_domains(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("There aren't any bypass domains"))
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_auto_proxy_discovery_state(output: &str) -> Option<bool> {
    for line in output.lines() {
        let trimmed = line.trim();

        if let Some(value) = trimmed.strip_prefix("Auto Proxy Discovery:") {
            return parse_on_off(value.trim());
        }

        if let Some(value) = trimmed.strip_prefix("Proxy Auto Discovery:") {
            return parse_on_off(value.trim());
        }
    }

    None
}

fn parse_auto_proxy_url_snapshot(output: &str) -> Option<MacosAutoProxyUrlSnapshot> {
    let mut enabled = None;
    let mut url = None;

    for line in output.lines() {
        let trimmed = line.trim();

        if let Some(value) = trimmed.strip_prefix("Enabled:") {
            enabled = parse_yes_no(value.trim());
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("URL:") {
            let parsed = value.trim();
            if !parsed.is_empty() {
                url = Some(parsed.to_string());
            }
        }
    }

    Some(MacosAutoProxyUrlSnapshot {
        enabled: enabled?,
        url,
    })
}

fn parse_yes_no(value: &str) -> Option<bool> {
    match value {
        "Yes" => Some(true),
        "No" => Some(false),
        _ => None,
    }
}

fn parse_on_off(value: &str) -> Option<bool> {
    match value {
        "On" | "on" => Some(true),
        "Off" | "off" => Some(false),
        _ => None,
    }
}

fn parse_optional_server(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if trimmed.is_empty() || trimmed == "(null)" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_optional_port(value: &str) -> Option<u16> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return None;
    }

    let Ok(parsed) = trimmed.parse::<u16>() else {
        return None;
    };

    if parsed == 0 { None } else { Some(parsed) }
}

#[derive(Copy, Clone)]
enum ProxyKind {
    Web,
    SecureWeb,
}

impl ProxyKind {
    fn get_command(self) -> &'static str {
        match self {
            Self::Web => "-getwebproxy",
            Self::SecureWeb => "-getsecurewebproxy",
        }
    }

    fn set_command(self) -> &'static str {
        match self {
            Self::Web => "-setwebproxy",
            Self::SecureWeb => "-setsecurewebproxy",
        }
    }

    fn state_command(self) -> &'static str {
        match self {
            Self::Web => "-setwebproxystate",
            Self::SecureWeb => "-setsecurewebproxystate",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::SecureWeb => "secure web",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_auto_proxy_discovery_state, parse_auto_proxy_url_snapshot,
        parse_network_services, parse_proxy_bypass_domains, parse_proxy_snapshot,
    };

    #[test]
    fn parses_enabled_proxy_snapshot() {
        let snapshot = parse_proxy_snapshot(
            "Enabled: Yes\nServer: 127.0.0.1\nPort: 8888\nAuthenticated Proxy Enabled: 0\n",
        )
        .expect("proxy snapshot should parse");

        assert!(snapshot.enabled);
        assert_eq!(snapshot.server.as_deref(), Some("127.0.0.1"));
        assert_eq!(snapshot.port, Some(8888));
    }

    #[test]
    fn parses_disabled_proxy_snapshot() {
        let snapshot = parse_proxy_snapshot(
            "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n",
        )
        .expect("proxy snapshot should parse");

        assert!(!snapshot.enabled);
        assert_eq!(snapshot.server, None);
        assert_eq!(snapshot.port, None);
    }

    #[test]
    fn filters_disabled_network_services() {
        let services = parse_network_services(
            "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n*Thunderbolt Bridge\nUSB 10/100/1000 LAN\n",
        );

        assert_eq!(services, vec!["Wi-Fi", "USB 10/100/1000 LAN"]);
    }

    #[test]
    fn parses_auto_proxy_discovery_state() {
        assert_eq!(
            parse_auto_proxy_discovery_state("Auto Proxy Discovery: On\n"),
            Some(true)
        );
        assert_eq!(
            parse_auto_proxy_discovery_state("Proxy Auto Discovery: Off\n"),
            Some(false)
        );
    }

    #[test]
    fn parses_auto_proxy_url_snapshot() {
        let snapshot = parse_auto_proxy_url_snapshot("URL: http://proxy.example/pac\nEnabled: Yes\n")
            .expect("auto proxy URL snapshot should parse");

        assert!(snapshot.enabled);
        assert_eq!(snapshot.url.as_deref(), Some("http://proxy.example/pac"));
    }

    #[test]
    fn parses_empty_bypass_domains() {
        let domains =
            parse_proxy_bypass_domains("There aren't any bypass domains set on Wi-Fi.\n");

        assert!(domains.is_empty());
    }

    #[test]
    fn parses_bypass_domains() {
        let domains = parse_proxy_bypass_domains("localhost\n127.0.0.1\n::1\n");

        assert_eq!(domains, vec!["localhost", "127.0.0.1", "::1"]);
    }
}
