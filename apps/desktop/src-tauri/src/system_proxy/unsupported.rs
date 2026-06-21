use super::SystemProxySettings;

#[derive(Debug, Clone)]
pub struct UnsupportedSystemProxySnapshot;

pub fn capture_system_proxy_snapshot() -> Result<UnsupportedSystemProxySnapshot, String> {
    Err("system proxy switching is not implemented for this platform.".to_string())
}

pub fn apply_system_proxy_settings(_settings: &SystemProxySettings) -> Result<(), String> {
    Err("system proxy switching is not implemented for this platform.".to_string())
}

pub fn apply_system_proxy_settings_with_pre_snapshot(
    _settings: &SystemProxySettings,
    _snapshot: UnsupportedSystemProxySnapshot,
) -> Result<(), String> {
    Err("system proxy switching is not implemented for this platform.".to_string())
}

pub fn restore_system_proxy(_snapshot: &UnsupportedSystemProxySnapshot) -> Result<(), String> {
    Err("system proxy switching is not implemented for this platform.".to_string())
}
