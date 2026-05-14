use super::SystemProxySettings;
use crate::dev_logger::{log_debug, log_error, log_info};
use serde::{Deserialize, Serialize};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
    RegKey,
};

const INTERNET_SETTINGS_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const PROXY_OVERRIDE_BYPASS_LOCAL: &str = "<local>";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WindowsSystemProxySnapshot {
    auto_config_url: Option<String>,
    auto_detect: Option<u32>,
    proxy_enable: u32,
    proxy_override: Option<String>,
    proxy_server: Option<String>,
}

pub fn capture_system_proxy_snapshot() -> Result<WindowsSystemProxySnapshot, String> {
    let key = open_settings_key()?;
    let snapshot = WindowsSystemProxySnapshot {
        auto_config_url: read_optional_string(&key, "AutoConfigURL")?,
        auto_detect: read_optional_dword(&key, "AutoDetect")?,
        proxy_enable: key.get_value("ProxyEnable").unwrap_or(0),
        proxy_override: read_optional_string(&key, "ProxyOverride")?,
        proxy_server: read_optional_string(&key, "ProxyServer")?,
    };

    log_debug(
        "desktop.system_proxy.windows",
        "snapshot_captured",
        &[
            ("proxy_enable", snapshot.proxy_enable.to_string()),
            (
                "proxy_server",
                snapshot
                    .proxy_server
                    .clone()
                    .unwrap_or_else(|| "<missing>".to_string()),
            ),
            (
                "proxy_override",
                snapshot
                    .proxy_override
                    .clone()
                    .unwrap_or_else(|| "<missing>".to_string()),
            ),
        ],
    );

    Ok(snapshot)
}

pub fn apply_system_proxy_settings(settings: &SystemProxySettings) -> Result<(), String> {
    let snapshot = capture_system_proxy_snapshot()?;
    apply_system_proxy_settings_with_pre_snapshot(settings, snapshot)
}

pub fn apply_system_proxy_settings_with_pre_snapshot(
    settings: &SystemProxySettings,
    _snapshot: WindowsSystemProxySnapshot,
) -> Result<(), String> {
    let key = open_settings_key()?;
    let endpoint = settings.endpoint();

    key.set_value("ProxyEnable", &1_u32)
        .map_err(|error| format!("failed to enable Windows system proxy: {error}"))?;
    key.set_value("ProxyServer", &endpoint)
        .map_err(|error| format!("failed to write Windows proxy server: {error}"))?;
    key.set_value("ProxyOverride", &PROXY_OVERRIDE_BYPASS_LOCAL)
        .map_err(|error| format!("failed to write Windows proxy bypass list: {error}"))?;
    remove_value_if_present(&key, "AutoConfigURL")?;
    key.set_value("AutoDetect", &0_u32)
        .map_err(|error| format!("failed to disable Windows proxy auto-detect: {error}"))?;

    refresh_system_proxy()?;

    log_info(
        "desktop.system_proxy.windows",
        "proxy_settings_applied",
        &[("endpoint", endpoint)],
    );

    Ok(())
}

pub fn restore_system_proxy(snapshot: &WindowsSystemProxySnapshot) -> Result<(), String> {
    let key = open_settings_key()?;

    key.set_value("ProxyEnable", &snapshot.proxy_enable)
        .map_err(|error| format!("failed to restore Windows proxy enabled flag: {error}"))?;
    write_optional_string(&key, "ProxyServer", snapshot.proxy_server.as_deref())?;
    write_optional_string(&key, "ProxyOverride", snapshot.proxy_override.as_deref())?;
    write_optional_string(&key, "AutoConfigURL", snapshot.auto_config_url.as_deref())?;

    match snapshot.auto_detect {
        Some(auto_detect) => key
            .set_value("AutoDetect", &auto_detect)
            .map_err(|error| format!("failed to restore Windows proxy auto-detect: {error}"))?,
        None => remove_value_if_present(&key, "AutoDetect")?,
    }

    refresh_system_proxy()?;

    log_info(
        "desktop.system_proxy.windows",
        "proxy_settings_restored",
        &[("proxy_enable", snapshot.proxy_enable.to_string())],
    );

    Ok(())
}

fn open_settings_key() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(INTERNET_SETTINGS_PATH, KEY_READ | KEY_WRITE)
        .map_err(|error| format!("failed to open Windows Internet Settings: {error}"))
}

fn read_optional_dword(key: &RegKey, name: &str) -> Result<Option<u32>, String> {
    match key.get_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to read Windows proxy DWORD value {name}: {error}"
        )),
    }
}

fn read_optional_string(key: &RegKey, name: &str) -> Result<Option<String>, String> {
    match key.get_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to read Windows proxy string value {name}: {error}"
        )),
    }
}

fn write_optional_string(key: &RegKey, name: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => key
            .set_value(name, &value)
            .map_err(|error| format!("failed to write Windows proxy string value {name}: {error}")),
        None => remove_value_if_present(key, name),
    }
}

fn remove_value_if_present(key: &RegKey, name: &str) -> Result<(), String> {
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to delete Windows proxy value {name}: {error}"
        )),
    }
}

fn refresh_system_proxy() -> Result<(), String> {
    let settings_changed =
        unsafe { InternetSetOptionW(null(), INTERNET_OPTION_SETTINGS_CHANGED, null_mut(), 0) };
    if settings_changed == 0 {
        let error = format!(
            "failed to notify WinINet about proxy setting changes: {}",
            std::io::Error::last_os_error()
        );
        log_error(
            "desktop.system_proxy.windows",
            "wininet_settings_changed_failed",
            &[("error", error.clone())],
        );
        return Err(error);
    }

    let refreshed = unsafe { InternetSetOptionW(null(), INTERNET_OPTION_REFRESH, null_mut(), 0) };
    if refreshed == 0 {
        let error = format!(
            "failed to refresh WinINet proxy settings: {}",
            std::io::Error::last_os_error()
        );
        log_error(
            "desktop.system_proxy.windows",
            "wininet_refresh_failed",
            &[("error", error.clone())],
        );
        return Err(error);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::SystemProxySettings;

    #[test]
    fn builds_the_expected_windows_proxy_endpoint() {
        let actual = SystemProxySettings::localhost(8888).endpoint();

        assert_eq!(actual, "127.0.0.1:8888");
    }
}
