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
mod host_pattern;
mod http_io;
mod http_proxy;
mod rules;
mod server;
mod ssl_proxying;
mod ssl_proxying_defaults;
mod stream;
mod timeouts;
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
    BreakpointReleaseReason, BreakpointReleased, BreakpointResolution, BreakpointRule,
    BreakpointStage, MockResponse,
};
pub use context::{ProxyConfig, ProxyManagers};
pub use error::ProxyError;
pub use rules::{
    DnsManager, DnsMappingRule, MapManager, MapRule, MapTrace, RewriteManager, RewriteRule,
    RewriteRuleMatch, RewriteTrace, RewriteTraceEntry, ThrottleManager, ThrottleProfileData,
    ThrottleRuleData, ThrottleRuntimeStats, ThrottleTrace,
};
pub use server::{send_direct_request, send_direct_request_bytes, start_proxy_server};
pub use ssl_proxying::{SslProxyingConfig, SslProxyingSettings};
pub use ssl_proxying_defaults::DEFAULT_SSL_PROXYING_EXCLUSIONS;
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

#[cfg(test)]
pub(crate) use timeouts::override_timeout_for_test;
pub(crate) use timeouts::{timeout as timeout_for, TimeoutKind};

/// Serializes tests that arm WebSocket timeout override slots.
///
/// The slots are process-global, and each [`TestTimeoutGuard`] zeroes its slot
/// on drop. Slot *independence* only protects tests arming DIFFERENT slots —
/// two concurrent tests arming the SAME slot still corrupt each other: the
/// later writer's value wins for both, and when either test finishes it zeroes
/// the slot while the other relay still depends on it (observed as an
/// inter-frame-idle test silently reverting a sibling's frame-read override
/// back to the 30s default and blowing its outer 2s bound). Affected tests
/// hold this lock across their whole body — declare the guard BEFORE arming
/// overrides so it drops after them.
#[cfg(test)]
pub(crate) static WS_TIMEOUT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Same contract as [`WS_TIMEOUT_TEST_LOCK`], for tests arming the
/// breakpoint-wait override slot (armed anywhere from 50ms to 30s).
#[cfg(test)]
pub(crate) static BREAKPOINT_WAIT_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

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
