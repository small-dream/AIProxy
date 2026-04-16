#[derive(Debug, Clone)]
pub struct SystemProxySettings {
    pub host: String,
    pub port: u16,
}

impl SystemProxySettings {
    pub fn localhost(port: u16) -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    LinuxSystemProxySnapshot as SystemProxySnapshot,
};
#[cfg(target_os = "macos")]
pub use macos::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    MacosSystemProxySnapshot as SystemProxySnapshot,
};
#[cfg(target_os = "windows")]
pub use windows::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    WindowsSystemProxySnapshot as SystemProxySnapshot,
};
