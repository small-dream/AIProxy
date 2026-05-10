use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use brotli::Decompressor;
use chrono::{DateTime, Utc};
use flate2::read::{GzDecoder, ZlibDecoder};
use httparse::{Request, Status, EMPTY_HEADER};
use reqwest::{
    header::{
        HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST,
        TRANSFER_ENCODING,
    },
    redirect::Policy,
    Client, Method, StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
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
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const DEV_LOG_ENV_VAR: &str = "AIPROXY_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "aiproxy-desktop-dev.log";
const MAX_CONCURRENT_CONNECTIONS: usize = 1024;
const CLIENT_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_BIND_ADDRESS: &str = "0.0.0.0";
const DEFAULT_HTTPS_PORT: u16 = 443;
const MAX_REQUEST_HEADERS: usize = 64;
const BROTLI_BUFFER_SIZE: usize = 4096;
const MAX_CAPTURED_BODY_BYTES: usize = 20 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = MAX_CAPTURED_BODY_BYTES;
const UDP_ROUTE_PROBE_ADDRESS: &str = "8.8.8.8:80";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

mod breakpoints;
mod http_io;
mod logging;
mod rules;
mod server;
mod types;
pub mod ws;

#[cfg(test)]
mod tests;

pub use breakpoints::{
    BreakpointActionKind, BreakpointEventEmitter, BreakpointHit, BreakpointManager,
    BreakpointResolution, BreakpointRule, BreakpointStage, MockResponse,
};
pub use aiproxy_rule_engine::{
    compile_script_rule, execute_request_hook, execute_response_hook, CompiledScriptRule,
    ScriptEntrypoints, ScriptHeader, ScriptHookPayload, ScriptLogLevel, ScriptManager,
    ScriptRequest, ScriptResponse, ScriptResponseOverride, ScriptRule, ScriptRuleLanguage,
    ScriptRuleMatch, ScriptRuleSourceType, ScriptRunEntry, ScriptRunEntryKind,
    ScriptRunOutcome, ScriptSessionInfo, ScriptTrace, ScriptTraceStage,
};
pub use rules::{
    DnsManager, DnsMappingRule, MapManager, MapRule, RewriteManager, RewriteRule,
    RewriteRuleMatch, ThrottleManager, ThrottleProfileData,
};
pub use server::{send_direct_request, start_proxy_server};
pub use ws::{WsConnectionRegistry, WsConnectionStatus, WsDirection, WsInjectRequest, WsMessageData, WsOpcode, global_ws_registry};
pub use types::{
    get_local_ip_addresses, ProxyBodyReference, ProxyHeaderEntry, ProxyRuntimeConfig,
    ProxyServerHandle, ProxySessionDetail, ProxySessionSummary, ProxyTimingBreakdown,
    StartedProxyServer, TlsManager,
};

pub(crate) use breakpoints::{
    apply_request_resolution, apply_response_resolution, build_mock_upstream_response,
    intercept_request_stage, intercept_response_stage,
};
pub(crate) use http_io::{
    build_body_reference, build_cookie_entries, build_header_entries_from_httparse_headers,
    build_header_entries_from_map, build_pending_session_detail, build_query_params,
    build_raw_http_head, build_request_path, build_session_detail, build_session_summary,
    build_upstream_headers, build_upstream_headers_from_entries,
    find_header_end, map_io_error, read_content_length, resolve_target_url,
    should_skip_response_header,
    should_skip_request_header, write_plain_text_response, write_upstream_response,
    SessionSummaryInput,
};
pub(crate) use logging::emit_log;
pub(crate) use rules::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_script_rules, apply_response_rewrite_rules,
    apply_response_throttle, resolve_dns_override, RequestRuntimeOutcome,
};
pub(crate) use types::{ParsedProxyRequest, UpstreamResponse};
