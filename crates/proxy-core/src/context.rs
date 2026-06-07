use super::*;
use crate::breakpoints::BreakpointEventEmitter;
use crate::rules::{DnsManager, MapManager, RewriteManager, ThrottleManager};
use crate::types::ProxyRuntimeConfig;
use aiproxy_rule_engine::ScriptManager;
use breakpoints::BreakpointManager;

/// Groups all rule/service managers into a single struct, replacing the
/// 8-argument pattern in `start_proxy_server` and `handle_connection`.
#[derive(Clone)]
pub struct ProxyManagers {
    pub tls: Option<Arc<TlsManager>>,
    pub breakpoint: Option<Arc<BreakpointManager>>,
    pub rewrite: Option<Arc<RewriteManager>>,
    pub map: Option<Arc<MapManager>>,
    pub script: Option<Arc<ScriptManager>>,
    pub throttle: Option<Arc<ThrottleManager>>,
    pub dns: Option<Arc<DnsManager>>,
}

/// Configuration parameters for starting a proxy server, excluding managers.
#[derive(Clone)]
pub struct ProxyConfig {
    pub runtime: ProxyRuntimeConfig,
    pub workspace_id: Option<String>,
    pub event_emitter: Option<BreakpointEventEmitter>,
}
