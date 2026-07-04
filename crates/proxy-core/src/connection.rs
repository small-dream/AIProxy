use super::*;
use std::net::SocketAddr;
use std::sync::Arc;

/// Distinguishes plain HTTP from MITM HTTPS at the type level.
/// URL construction, protocol string, pseudo-header synthesis,
/// and TLS metadata all branch on this enum.
#[derive(Debug, Clone)]
pub(crate) enum ConnectionMode {
    PlainHttp,
    MitmHttps {
        host: String, // CONNECT target host
        #[allow(dead_code)]
        port: u16, // CONNECT target port
        tls_protocol: Option<String>,
        tls_cipher_suite: Option<String>,
        #[allow(dead_code)]
        tls_ms: u128,
        alpn_protocol: Option<String>, // "h2" | "http/1.1" | None
    },
}

impl ConnectionMode {
    /// The protocol string stored in ParsedProxyRequest.protocol.
    pub(crate) fn protocol(&self) -> &str {
        match self {
            ConnectionMode::PlainHttp => "http",
            ConnectionMode::MitmHttps { alpn_protocol, .. } => {
                if alpn_protocol.as_deref() == Some("h2") {
                    "h2"
                } else {
                    "https"
                }
            }
        }
    }

    /// Whether this connection uses HTTP/2 (h2 ALPN negotiated).
    pub(crate) fn is_h2(&self) -> bool {
        matches!(self, ConnectionMode::MitmHttps { alpn_protocol: Some(a), .. } if a == "h2")
    }
}

/// Per-connection state shared across all requests on this connection.
/// Per-request state (timing, request_id) is NOT stored here —
/// it is created inside HttpProxyService::call for each request.
pub(crate) struct ConnectionContext {
    pub mode: ConnectionMode,
    pub client_addr: SocketAddr,
    pub session_sender: mpsc::Sender<ProxySessionDetail>,
    #[allow(dead_code)]
    pub ws_message_sender: mpsc::Sender<crate::ws::WsMessageData>,
    pub rewrite_manager: Option<Arc<RewriteManager>>,
    pub map_manager: Option<Arc<MapManager>>,
    pub script_manager: Option<Arc<ScriptManager>>,
    pub throttle_manager: Option<Arc<ThrottleManager>>,
    pub breakpoint_manager: Option<Arc<BreakpointManager>>,
    pub dns_manager: Option<Arc<DnsManager>>,
    pub workspace_id: String,
    pub event_emitter: Option<BreakpointEventEmitter>,
    pub upstream_pool: Arc<crate::upstream_pool::UpstreamConnectionPool>,
    /// H3: when true, new upstream HTTPS/WSS connections verify the server
    /// certificate against the OS root store. Fixed for the connection's
    /// lifetime; toggling the workspace setting affects subsequent connections.
    pub verify_upstream_tls: bool,
    /// H3: per-host allowlist that forces TLS verification for these hosts
    /// even when `verify_upstream_tls` is false. Shared (Arc) so connections
    /// don't clone the list. The connector checks `contains(host)` per
    /// connection and ORs it with `verify_upstream_tls`.
    pub tls_verify_hosts: Arc<[String]>,
}
