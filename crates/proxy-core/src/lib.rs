use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use brotli::Decompressor;
use chrono::{DateTime, Utc};
use flate2::read::{GzDecoder, ZlibDecoder};
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
const DEFAULT_BIND_ADDRESS: &str = "0.0.0.0";
const DEFAULT_HTTPS_PORT: u16 = 443;
const MAX_REQUEST_HEADERS: usize = 64;
const BROTLI_BUFFER_SIZE: usize = 4096;
const MAX_CAPTURED_BODY_BYTES: usize = 20 * 1024 * 1024;
const UDP_ROUTE_PROBE_ADDRESS: &str = "8.8.8.8:80";

mod breakpoints;
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
mod upstream_pool;
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

#[cfg(test)]
pub(crate) fn override_upstream_request_timeout_for_test(timeout: Duration) -> TestTimeoutGuard {
    TEST_UPSTREAM_REQUEST_TIMEOUT_MS.store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard
}

#[cfg(test)]
pub(crate) struct TestTimeoutGuard;

#[cfg(test)]
impl Drop for TestTimeoutGuard {
    fn drop(&mut self) {
        TEST_UPSTREAM_REQUEST_TIMEOUT_MS.store(0, Ordering::SeqCst);
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
    build_upstream_headers, build_upstream_headers_from_entries, find_header_end, map_io_error,
    resolve_target_url, should_skip_request_header, write_plain_text_response, OwnedPrefixedStream,
    SessionSummaryInput,
};
pub(crate) use http_proxy::HttpProxyService;
pub(crate) use rules::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_rewrite_rules, apply_response_script_rules, apply_response_throttle,
    resolve_dns_override, throttle_selection_matches_stage, RequestRuntimeOutcome,
    ThrottleRuntimeSelection,
};
pub(crate) use types::{ParsedProxyRequest, UpstreamResponse};
