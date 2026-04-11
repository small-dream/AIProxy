use super::SystemProxySettings;

#[derive(Debug, Clone)]
pub struct MacosSystemProxySnapshot;

pub fn capture_system_proxy_snapshot() -> Result<MacosSystemProxySnapshot, String> {
    Err("macOS system proxy switching is not implemented yet.".to_string())
}

pub fn apply_system_proxy_settings(_settings: &SystemProxySettings) -> Result<(), String> {
    Err("macOS system proxy switching is not implemented yet.".to_string())
}

pub fn restore_system_proxy(_snapshot: &MacosSystemProxySnapshot) -> Result<(), String> {
    Err("macOS system proxy switching is not implemented yet.".to_string())
}
