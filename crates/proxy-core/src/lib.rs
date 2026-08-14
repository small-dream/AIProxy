use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use brotli::Decompressor;
use chrono::{DateTime, Utc};
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use http::header::{
    CONNECTION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HOST, TRANSFER_ENCODING,
};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use httparse::{Request, Status, EMPTY_HEADER};
use reqwest::{redirect::Policy, Client};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self},
    io::{self, Cursor, Read},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, Semaphore},
    task::JoinHandle,
    time::{sleep, timeout},
};
use url::Url;
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const MAX_CONCURRENT_CONNECTIONS: usize = 1024;
const CLIENT_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const UPSTREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(test)]
static TEST_UPSTREAM_REQUEST_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
// CONNECT blind tunnel: TCP connect to upstream must be bounded so a slow/
// unreachable target cannot hold a connection permit indefinitely. Shorter
// than the full upstream request timeout — establishing a TCP connection
// should be fast; anything beyond this is a stuck/unreachable target.
const CONNECT_TUNNEL_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
// CONNECT blind tunnel relay idle ceiling. Long enough to not disturb legit
// long-lived idle tunnels (e.g. SSH-over-CONNECT keepalive gaps), short
// enough to reclaim the connection permit from a truly dead peer and avoid
// unbounded permit-pool exhaustion (max 1024 concurrent connections).
const TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
#[cfg(test)]
static TEST_TUNNEL_IDLE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
// Long enough for real debugging sessions, short enough to avoid leaking a
// pending entry + upstream connection forever if the frontend disconnects or
// the breakpoint-hit emitter (fire-and-forget) fails to deliver.
const BREAKPOINT_WAIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(test)]
static TEST_BREAKPOINT_WAIT_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
// WebSocket relay close-grace ceiling. Once a Close frame has been seen from
// either peer the relay starts a grace timer: long enough for a compliant
// peer to echo a Close back, short enough that a non-compliant / half-closed
// / packet-losing peer cannot keep the relay (and the TCP connection) alive
// forever. See `ws::relay_websocket_frames`.
const WS_CLOSE_GRACE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
static TEST_WS_CLOSE_GRACE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
// WebSocket upgrade non-101 body: per-read idle ceiling. A non-101 refusal on
// an HTTP/1.1 keep-alive connection with no Content-Length would otherwise
// block on upstream.read() forever — the peer keeps the connection open and
// never sends EOF. Each read is bounded so the client always receives the
// (possibly partial) refusal body instead of hanging indefinitely. See
// `ws_upgrade::read_full_response_body`.
const WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
static TEST_WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
const DEFAULT_BIND_ADDRESS: &str = "0.0.0.0";
const DEFAULT_HTTPS_PORT: u16 = 443;
const MAX_REQUEST_HEADERS: usize = 64;
const BROTLI_BUFFER_SIZE: usize = 4096;
const MAX_CAPTURED_BODY_BYTES: usize = 20 * 1024 * 1024;
const UDP_ROUTE_PROBE_ADDRESS: &str = "8.8.8.8:80";

mod breakpoints;
mod connect;
mod connection;
mod context;
mod error;
mod http_io;
mod http_proxy;
mod rules;
mod server;
mod stream;
mod timing_connector;
mod types;
mod upstream;
mod upstream_pool;
mod upstream_proxy;
pub mod ws;
mod ws_upgrade;

#[cfg(test)]
mod tests;

pub use aiproxy_rule_engine::{
    compile_script_rule, execute_request_hook, execute_response_hook, CompiledScriptRule,
    ScriptEntrypoints, ScriptHeader, ScriptHookPayload, ScriptLogLevel, ScriptManager,
    ScriptRequest, ScriptResponse, ScriptResponseOverride, ScriptRule, ScriptRuleLanguage,
    ScriptRuleMatch, ScriptRuleSourceType, ScriptRunEntry, ScriptRunEntryKind, ScriptRunOutcome,
    ScriptSessionInfo, ScriptTrace, ScriptTraceStage,
};
pub use breakpoints::{
    BreakpointActionKind, BreakpointEventEmitter, BreakpointHit, BreakpointManager,
    BreakpointResolution, BreakpointRule, BreakpointStage, MockResponse,
};
pub use context::{ProxyConfig, ProxyManagers};
pub use error::ProxyError;
pub use rules::{
    DnsManager, DnsMappingRule, MapManager, MapRule, MapTrace, RewriteManager, RewriteRule,
    RewriteRuleMatch, RewriteTrace, RewriteTraceEntry, ThrottleManager, ThrottleProfileData,
    ThrottleRuleData, ThrottleRuntimeStats, ThrottleTrace,
};
pub use server::{send_direct_request, start_proxy_server};
pub use timing_connector::{ConnectionTiming, TimingConnector};
pub use types::{
    get_local_ip_addresses, infer_protocol_metadata, ProxyBodyReference, ProxyHeaderEntry,
    ProxyProtocolMetadata, ProxyRuntimeConfig, ProxyServerHandle, ProxySessionDetail,
    ProxySessionSummary, ProxyTimingBreakdown, StartedProxyServer, TlsManager,
};
pub use upstream_proxy::{
    bypass_matches, default_bypass_patterns, probe_upstream_proxy, UpstreamProxyConfig,
    UpstreamProxyProbeResult, UpstreamProxyProtocol, UpstreamProxySettings, DEFAULT_PROBE_TARGET,
};
pub use ws::{
    global_ws_registry, WsConnectionRegistry, WsConnectionStatus, WsDirection, WsInjectRequest,
    WsMessageData, WsOpcode,
};

pub(crate) fn upstream_request_timeout() -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = TEST_UPSTREAM_REQUEST_TIMEOUT_MS.load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    UPSTREAM_REQUEST_TIMEOUT
}

/// CONNECT blind-tunnel TCP connect timeout. Bounded so a slow/unreachable
/// upstream cannot hold a connection permit indefinitely.
pub(crate) fn connect_tunnel_connect_timeout() -> Duration {
    CONNECT_TUNNEL_CONNECT_TIMEOUT
}

/// CONNECT blind-tunnel relay idle ceiling. Bounded so an upstream that
/// accepts the TCP connection but then stays silent (dead peer, half-open)
/// cannot hold a permit forever and exhaust the connection pool.
pub(crate) fn tunnel_idle_timeout() -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = TEST_TUNNEL_IDLE_TIMEOUT_MS.load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    TUNNEL_IDLE_TIMEOUT
}

/// WebSocket relay close-grace ceiling. Once a Close frame has been seen the
/// relay arms this deadline and force-terminates when it elapses, so a peer
/// that never echoes a Close cannot leak the relay/TCP connection.
pub(crate) fn ws_close_grace_timeout() -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = TEST_WS_CLOSE_GRACE_TIMEOUT_MS.load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    WS_CLOSE_GRACE_TIMEOUT
}

/// WebSocket upgrade non-101 body: per-read idle ceiling. Bounds each read of
/// a refused upstream response body so a keep-alive peer without a
/// Content-Length cannot block the proxy forever.
pub(crate) fn ws_upstream_body_read_idle_timeout() -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = TEST_WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT_MS.load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT
}

#[cfg(test)]
pub(crate) fn override_upstream_request_timeout_for_test(timeout: Duration) -> TestTimeoutGuard {
    TEST_UPSTREAM_REQUEST_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: &TEST_UPSTREAM_REQUEST_TIMEOUT_MS,
    }
}

/// RAII guard that resets exactly the test timeout slot it armed on drop.
/// Each slot is independent, so concurrent tests (cargo test runs threads in
/// parallel) cannot clobber each other's overrides — finishing one test must
/// not zero a different slot that another in-flight test still depends on,
/// which would silently drop it back to the slow default (e.g. 120s).
#[cfg(test)]
pub(crate) struct TestTimeoutGuard {
    slot: &'static AtomicU64,
}

#[cfg(test)]
impl Drop for TestTimeoutGuard {
    fn drop(&mut self) {
        self.slot.store(0, Ordering::SeqCst);
    }
}

pub(crate) fn breakpoint_wait_timeout() -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = TEST_BREAKPOINT_WAIT_TIMEOUT_MS.load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    BREAKPOINT_WAIT_TIMEOUT
}

#[cfg(test)]
pub(crate) fn override_breakpoint_wait_timeout_for_test(timeout: Duration) -> TestTimeoutGuard {
    TEST_BREAKPOINT_WAIT_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: &TEST_BREAKPOINT_WAIT_TIMEOUT_MS,
    }
}

#[cfg(test)]
pub(crate) fn override_tunnel_idle_timeout_for_test(timeout: Duration) -> TestTimeoutGuard {
    TEST_TUNNEL_IDLE_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: &TEST_TUNNEL_IDLE_TIMEOUT_MS,
    }
}

#[cfg(test)]
pub(crate) fn override_ws_close_grace_timeout_for_test(timeout: Duration) -> TestTimeoutGuard {
    TEST_WS_CLOSE_GRACE_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: &TEST_WS_CLOSE_GRACE_TIMEOUT_MS,
    }
}

#[cfg(test)]
pub(crate) fn override_ws_upstream_body_read_idle_timeout_for_test(
    timeout: Duration,
) -> TestTimeoutGuard {
    TEST_WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: &TEST_WS_UPSTREAM_BODY_READ_IDLE_TIMEOUT_MS,
    }
}

#[cfg(test)]
pub(crate) use breakpoints::apply_request_resolution;
pub(crate) use breakpoints::{
    apply_response_resolution, build_mock_upstream_response, intercept_request_stage,
    intercept_response_stage,
};
pub(crate) use connection::{ConnectionContext, ConnectionMode};
pub(crate) use http_io::{
    build_body_reference, build_cookie_entries, build_header_entries_from_httparse_headers,
    build_header_entries_from_map, build_pending_session_detail, build_query_params,
    build_raw_http_head, build_request_path, build_session_detail, build_session_summary,
    build_upstream_headers, build_upstream_headers_from_entries, find_header_end,
    hop_by_hop_strip_set, is_pseudo_header_name, map_io_error, resolve_target_url,
    should_skip_request_header, should_strip_hop_by_hop, write_plain_text_response,
    OwnedPrefixedStream, SessionSummaryInput,
};
pub(crate) use http_proxy::HttpProxyService;
pub(crate) use rules::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_rewrite_rules, apply_response_script_rules, evaluate_response_throttle,
    resolve_dns_override, throttle_response_body, throttle_selection_matches_stage,
    RequestRuntimeOutcome, ThrottleRuntimeSelection,
};
pub(crate) use types::{ParsedProxyRequest, UpstreamResponse};
