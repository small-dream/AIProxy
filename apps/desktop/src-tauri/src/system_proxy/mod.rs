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
// Fallback for any platform that is not Windows/macOS/Linux (e.g. FreeBSD),
// so the crate still compiles and commands return a clear "not implemented"
// error instead of failing to resolve symbols (L5).
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod unsupported;

#[cfg(target_os = "linux")]
pub use linux::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy,
    LinuxSystemProxySnapshot as SystemProxySnapshot,
};
#[cfg(target_os = "macos")]
pub use macos::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy,
    MacosSystemProxySnapshot as SystemProxySnapshot,
};
#[cfg(target_os = "windows")]
pub use windows::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy,
    WindowsSystemProxySnapshot as SystemProxySnapshot,
};
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub use unsupported::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy,
    UnsupportedSystemProxySnapshot as SystemProxySnapshot,
};
