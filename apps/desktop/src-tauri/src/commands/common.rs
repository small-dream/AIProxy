pub(super) use crate::bootstrap::{
    AppState, BootstrapStatus, CertificateStateSnapshot, RuntimeHandles, SESSION_BATCH_SIZE,
};
pub(super) use crate::dev_logger::{log_debug, log_error, log_info, log_warn};
pub(super) use crate::session_stats;
pub(super) use crate::system_proxy::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy, SystemProxySettings,
};
pub(super) use crate::workspace::WorkspaceData;
pub(super) use aiproxy_proxy_core::{
    compile_script_rule, get_local_ip_addresses, global_ws_registry, send_direct_request,
    start_proxy_server, BreakpointEventEmitter, BreakpointResolution, BreakpointRule,
    BreakpointStage, DnsMappingRule, MapRule, ProxyHeaderEntry, ProxyRuntimeConfig,
    ProxySessionDetail, ProxySessionSummary, ProxyTimingBreakdown, RewriteRule, ScriptRule,
    ScriptRuleLanguage, ScriptRuleSourceType, ThrottleProfileData, ThrottleRuleData,
    ThrottleRuntimeStats, TlsManager, WsConnectionStatus, WsDirection, WsOpcode,
};
pub(super) use aiproxy_tls_manager::{
    detect_platform, is_cert_trusted_on_platform, CertStorage, RootCaPair,
};
pub(super) use serde::{Deserialize, Serialize};
pub(super) use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
pub(super) use tauri::{Emitter, State};
pub(super) use tauri_plugin_opener::OpenerExt;
pub(super) use url::{form_urlencoded, Url};

pub(super) const DEFAULT_PROXY_PORT: u16 = 8888;
pub(super) const EAGER_SESSION_DETAIL_BODY_LIMIT_BYTES: usize = 64 * 1024;
pub(super) const MAX_IMPORTED_SCRIPT_BYTES: usize = 128 * 1024;

pub(super) async fn run_blocking_command<T, F>(
    command_name: &'static str,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{command_name} blocking task failed: {error}"))?
}
