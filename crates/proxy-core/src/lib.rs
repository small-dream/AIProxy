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
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const DEV_LOG_ENV_VAR: &str = "PHARLES_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "pharles-desktop-dev.log";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyRuntimeConfig {
    pub port: u16,
    pub ssl_enabled: bool,
}

impl ProxyRuntimeConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.port == 0 {
            return Err("proxy port must be greater than zero");
        }

        Ok(())
    }
}

/// Returns the local network IP addresses of this machine.
/// Used to tell mobile devices what IP to configure as their proxy.
pub fn get_local_ip_addresses() -> Vec<String> {
    let mut ips = Vec::new();

    // Use a UDP socket trick to find the preferred outbound local IP.
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // connect() doesn't actually send data, it just selects the route
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip().to_string();
                if ip != "0.0.0.0" {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionSummary {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub protocol: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub size_bytes: usize,
    pub status_code: u16,
    pub url: String,
    pub response_mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHeaderEntry {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBodyReference {
    pub base64_text: Option<String>,
    pub encoding: Option<String>,
    pub inline_text: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTimingBreakdown {
    pub connect_ms: Option<u128>,
    pub dns_ms: Option<u128>,
    pub request_send_ms: Option<u128>,
    pub response_read_ms: Option<u128>,
    pub tls_ms: Option<u128>,
    pub total_ms: Option<u128>,
    pub waiting_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionDetail {
    pub cookies: Vec<ProxyHeaderEntry>,
    pub id: String,
    pub query_params: Vec<ProxyHeaderEntry>,
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
    pub request_body: Option<ProxyBodyReference>,
    pub request_headers: Vec<ProxyHeaderEntry>,
    pub response_body: Option<ProxyBodyReference>,
    pub response_headers: Vec<ProxyHeaderEntry>,
    pub server_ip: Option<String>,
    pub summary: ProxySessionSummary,
    pub timing: Option<ProxyTimingBreakdown>,
}

#[derive(Debug)]
pub struct ProxyServerHandle {
    shutdown_sender: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
}

impl ProxyServerHandle {
    pub async fn shutdown(mut self) {
        if let Some(shutdown_sender) = self.shutdown_sender.take() {
            let _ = shutdown_sender.send(());
        }

        let _ = self.join_handle.await;
    }
}

#[derive(Debug)]
pub struct StartedProxyServer {
    pub bound_port: u16,
    pub server_handle: ProxyServerHandle,
    pub session_receiver: mpsc::UnboundedReceiver<ProxySessionDetail>,
}

/// TLS manager for HTTPS MITM interception.
pub struct TlsManager {
    pub root_ca: pharles_tls_manager::RootCaPair,
    pub storage: Arc<pharles_tls_manager::CertStorage>,
    pub server_config: Arc<tokio_rustls::rustls::ServerConfig>,
}

impl std::fmt::Debug for TlsManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsManager").finish()
    }
}

#[derive(Debug)]
struct ParsedProxyRequest {
    body: Vec<u8>,
    headers: HeaderMap,
    host: String,
    method: Method,
    path: String,
    protocol: String,
    query_params: Vec<ProxyHeaderEntry>,
    raw_request: String,
    request_headers: Vec<ProxyHeaderEntry>,
    request_id: String,
    url: Url,
}

#[derive(Debug)]
struct UpstreamResponse {
    response_body: Vec<u8>,
    response_headers: HeaderMap,
    response_read_ms: u128,
    status_code: StatusCode,
    waiting_ms: u128,
}

// ---------------------------------------------------------------------------
// Breakpoint types
// ---------------------------------------------------------------------------

/// The stage at which a breakpoint can trigger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BreakpointStage {
    Request,
    Response,
}

/// What the user chooses to do with an intercepted request/response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BreakpointActionKind {
    Forward,
    Drop,
    Mock,
}

/// A user-crafted response used when the action is Mock.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MockResponse {
    pub status_code: u16,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body_base64: Option<String>,
}

/// The resolution the frontend sends back to unblock the proxy task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointResolution {
    pub session_id: String,
    pub action: BreakpointActionKind,
    pub mock: Option<MockResponse>,
    pub modified_request_headers: Option<Vec<ProxyHeaderEntry>>,
    pub modified_request_body_base64: Option<String>,
    pub modified_response_headers: Option<Vec<ProxyHeaderEntry>>,
    pub modified_response_body_base64: Option<String>,
}

/// A rule that determines which requests should trigger a breakpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointRule {
    pub id: String,
    pub enabled: bool,
    pub url_pattern: String,
    pub methods: Vec<String>,
    pub stage: BreakpointStage,
}

/// Payload pushed to the frontend when a breakpoint is hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointHit {
    pub session_id: String,
    pub stage: BreakpointStage,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub request_headers: Vec<ProxyHeaderEntry>,
    pub request_body: Option<ProxyBodyReference>,
    pub response_status_code: Option<u16>,
    pub response_headers: Option<Vec<ProxyHeaderEntry>>,
    pub response_body: Option<ProxyBodyReference>,
}

/// Callback for emitting events from the proxy core to the frontend.
/// Keeps proxy-core framework-agnostic (no direct tauri dependency).
pub type BreakpointEventEmitter =
    Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

// ---------------------------------------------------------------------------
// BreakpointManager
// ---------------------------------------------------------------------------

/// Manages active breakpoint rules and pending interceptions.
pub struct BreakpointManager {
    rules: std::sync::Mutex<Vec<BreakpointRule>>,
    pending: std::sync::Mutex<HashMap<String, oneshot::Sender<BreakpointResolution>>>,
}

impl std::fmt::Debug for BreakpointManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BreakpointManager")
            .field("rules", &self.list_rules())
            .field("pending_count", &self.pending.lock().map(|p| p.len()).unwrap_or(0))
            .finish()
    }
}

impl BreakpointManager {
    pub fn new() -> Self {
        Self {
            rules: std::sync::Mutex::new(Vec::new()),
            pending: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn list_rules(&self) -> Vec<BreakpointRule> {
        self.rules
            .lock()
            .expect("breakpoint rules mutex should not be poisoned")
            .clone()
    }

    pub fn set_rules(&self, rules: Vec<BreakpointRule>) {
        let mut guard = self
            .rules
            .lock()
            .expect("breakpoint rules mutex should not be poisoned");
        *guard = rules;
    }

    /// Check whether any enabled rule matches the given stage/method/url.
    pub fn should_break(&self, stage: &BreakpointStage, method: &str, url: &str) -> bool {
        let rules = self
            .rules
            .lock()
            .expect("breakpoint rules mutex should not be poisoned");
        rules.iter().any(|rule| {
            if !rule.enabled {
                return false;
            }
            if rule.stage != *stage {
                return false;
            }
            if !rule.methods.is_empty()
                && !rule
                    .methods
                    .iter()
                    .any(|m| m.eq_ignore_ascii_case(method))
            {
                return false;
            }
            // URL pattern: empty or "*" matches everything; otherwise substring match
            if rule.url_pattern.is_empty() || rule.url_pattern == "*" {
                return true;
            }
            url.contains(&rule.url_pattern)
        })
    }

    /// Register a pending breakpoint. Returns the receiver end that the proxy task will await.
    pub fn register_pending(
        &self,
        session_id: String,
    ) -> oneshot::Receiver<BreakpointResolution> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("breakpoint pending mutex should not be poisoned")
            .insert(session_id, tx);
        rx
    }

    /// Resolve a pending breakpoint by sending the user's decision.
    pub fn resolve(&self, session_id: &str, resolution: BreakpointResolution) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .expect("breakpoint pending mutex should not be poisoned");
        if let Some(sender) = pending.remove(session_id) {
            sender
                .send(resolution)
                .map_err(|_| "failed to send breakpoint resolution — receiver already dropped".to_string())
        } else {
            Err(format!("no pending breakpoint found for session {session_id}"))
        }
    }

    /// Cancel all pending breakpoints (e.g. when the proxy stops).
    pub fn cancel_all(&self) {
        let mut pending = self
            .pending
            .lock()
            .expect("breakpoint pending mutex should not be poisoned");
        pending.clear();
    }
}

// ---------------------------------------------------------------------------
// Rewrite / Map / Throttle types and managers
// ---------------------------------------------------------------------------

/// A generic rewrite rule matching on URL pattern, methods, and stage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub url_pattern: String,
    pub methods: Vec<String>,
    pub stage: String,
    pub rewrite_type: String,
    pub workspace_id: String,
    pub payload: serde_json::Value,
}

/// A map rule (local or remote) matching on source URL pattern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapRule {
    pub id: String,
    pub enabled: bool,
    pub mode: String,
    pub name: String,
    pub note: Option<String>,
    pub preserve_path: bool,
    pub preserve_query: bool,
    pub priority: u32,
    pub source_pattern: String,
    pub target_value: String,
    pub workspace_id: String,
}

/// A throttle profile for bandwidth/latency/packet-loss simulation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleProfileData {
    pub id: String,
    pub download_kbps: u32,
    pub enabled: bool,
    pub latency_ms: u32,
    pub name: String,
    pub note: Option<String>,
    pub packet_loss_ratio: f32,
    pub preset: bool,
    pub upload_kbps: u32,
    pub workspace_id: String,
}

/// Manages rewrite rules in memory.
pub struct RewriteManager {
    rules: Mutex<Vec<RewriteRule>>,
}

impl std::fmt::Debug for RewriteManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RewriteManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl RewriteManager {
    pub fn new() -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn list_rules(&self) -> Vec<RewriteRule> {
        self.rules.lock().expect("rewrite rules mutex").clone()
    }

    pub fn save_rule(&self, rule: RewriteRule) -> RewriteRule {
        let mut rules = self.rules.lock().expect("rewrite rules mutex");
        if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().expect("rewrite rules mutex");
        rules.retain(|r| r.id != rule_id);
    }
}

/// Manages map rules (local + remote) in memory.
pub struct MapManager {
    rules: Mutex<Vec<MapRule>>,
}

impl std::fmt::Debug for MapManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MapManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl MapManager {
    pub fn new() -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn list_rules(&self) -> Vec<MapRule> {
        self.rules.lock().expect("map rules mutex").clone()
    }

    pub fn save_rule(&self, rule: MapRule) -> MapRule {
        let mut rules = self.rules.lock().expect("map rules mutex");
        if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().expect("map rules mutex");
        rules.retain(|r| r.id != rule_id);
    }
}

/// Manages throttle profiles in memory.
pub struct ThrottleManager {
    profiles: Mutex<Vec<ThrottleProfileData>>,
}

impl std::fmt::Debug for ThrottleManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThrottleManager")
            .field("profiles_count", &self.list_profiles().len())
            .finish()
    }
}

impl ThrottleManager {
    pub fn new() -> Self {
        Self {
            profiles: Mutex::new(Vec::new()),
        }
    }

    pub fn list_profiles(&self) -> Vec<ThrottleProfileData> {
        self.profiles.lock().expect("throttle profiles mutex").clone()
    }

    pub fn save_profile(&self, profile: ThrottleProfileData) -> ThrottleProfileData {
        let mut profiles = self.profiles.lock().expect("throttle profiles mutex");
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        profile
    }

    pub fn delete_profile(&self, profile_id: &str) {
        let mut profiles = self.profiles.lock().expect("throttle profiles mutex");
        profiles.retain(|p| p.id != profile_id);
    }

    pub fn set_active_profile(&self, workspace_id: &str, profile_id: Option<&str>) {
        let mut profiles = self.profiles.lock().expect("throttle profiles mutex");
        for profile in profiles.iter_mut() {
            if profile.workspace_id == workspace_id {
                profile.enabled = match profile_id {
                    Some(id) => profile.id == id,
                    None => false,
                };
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Breakpoint interception helpers
// ---------------------------------------------------------------------------

/// Build a BreakpointHit for the request stage from a parsed request.
fn build_request_stage_hit(request: &ParsedProxyRequest) -> BreakpointHit {
    let content_type = request.headers.get(CONTENT_TYPE);
    let content_encoding = request.headers.get("content-encoding");
    BreakpointHit {
        session_id: request.request_id.clone(),
        stage: BreakpointStage::Request,
        method: request.method.to_string(),
        url: request.url.to_string(),
        host: request.host.clone(),
        path: request.path.clone(),
        request_headers: request.request_headers.clone(),
        request_body: build_body_reference(&request.body, content_type, content_encoding),
        response_status_code: None,
        response_headers: None,
        response_body: None,
    }
}

/// Build a BreakpointHit for the response stage.
fn build_response_stage_hit(
    request: &ParsedProxyRequest,
    status_code: u16,
    response_headers: &HeaderMap,
    response_body: &[u8],
) -> BreakpointHit {
    let req_content_type = request.headers.get(CONTENT_TYPE);
    let req_content_encoding = request.headers.get("content-encoding");
    let resp_content_type = response_headers.get(CONTENT_TYPE);
    let resp_content_encoding = response_headers.get("content-encoding");
    BreakpointHit {
        session_id: request.request_id.clone(),
        stage: BreakpointStage::Response,
        method: request.method.to_string(),
        url: request.url.to_string(),
        host: request.host.clone(),
        path: request.path.clone(),
        request_headers: request.request_headers.clone(),
        request_body: build_body_reference(&request.body, req_content_type, req_content_encoding),
        response_status_code: Some(status_code),
        response_headers: Some(
            response_headers
                .iter()
                .map(|(k, v)| ProxyHeaderEntry {
                    name: k.to_string(),
                    value: v.to_str().unwrap_or("").to_string(),
                })
                .collect(),
        ),
        response_body: build_body_reference(response_body, resp_content_type, resp_content_encoding),
    }
}

/// Emit a breakpoint-hit event through the event emitter callback.
fn emit_breakpoint_event(emitter: &Option<BreakpointEventEmitter>, hit: &BreakpointHit) {
    if let Some(ref emit) = emitter {
        let payload = serde_json::to_value(hit).unwrap_or_else(|e| {
            emit_log("ERROR", "breakpoint_hit_serialize_failed", &[("error", e.to_string())]);
            serde_json::Value::Null
        });
        emit("breakpoint-hit", payload);
    }
}

/// Check for a request-stage breakpoint. If matched, emits the event, waits for resolution,
/// and returns the resolution. Returns `None` if no breakpoint rule matched.
async fn intercept_request_stage(
    breakpoint_manager: &Option<Arc<BreakpointManager>>,
    event_emitter: &Option<BreakpointEventEmitter>,
    request: &mut ParsedProxyRequest,
) -> Result<Option<BreakpointResolution>, String> {
    let bp = match breakpoint_manager {
        Some(bp) => bp,
        None => return Ok(None),
    };

    if !bp.should_break(&BreakpointStage::Request, request.method.as_str(), request.url.as_str()) {
        return Ok(None);
    }

    let session_id = request.request_id.clone();
    let receiver = bp.register_pending(session_id.clone());

    let hit = build_request_stage_hit(request);
    emit_log(
        "INFO",
        "breakpoint_request_stage_hit",
        &[
            ("session_id", session_id.clone()),
            ("method", request.method.to_string()),
            ("url", request.url.to_string()),
        ],
    );
    emit_breakpoint_event(event_emitter, &hit);

    match receiver.await {
        Ok(resolution) => {
            // Apply modifications to the request
            if let Some(ref headers) = resolution.modified_request_headers {
                request.request_headers = headers.clone();
                let mut new_headers = HeaderMap::new();
                for entry in headers {
                    if let (Ok(name), Ok(value)) = (
                        HeaderName::from_bytes(entry.name.as_bytes()),
                        HeaderValue::from_str(&entry.value),
                    ) {
                        new_headers.insert(name, value);
                    }
                }
                request.headers = new_headers;
            }
            if let Some(ref body_b64) = resolution.modified_request_body_base64 {
                request.body = BASE64_STANDARD
                    .decode(body_b64)
                    .unwrap_or_else(|_| body_b64.as_bytes().to_vec());
            }
            Ok(Some(resolution))
        }
        Err(_) => {
            emit_log(
                "WARN",
                "breakpoint_request_cancelled",
                &[("session_id", session_id)],
            );
            Err("breakpoint cancelled (proxy may have stopped)".to_string())
        }
    }
}

/// Check for a response-stage breakpoint. If matched, emits the event, waits for resolution,
/// and returns the resolution. Returns `None` if no breakpoint rule matched.
async fn intercept_response_stage(
    breakpoint_manager: &Option<Arc<BreakpointManager>>,
    event_emitter: &Option<BreakpointEventEmitter>,
    request: &ParsedProxyRequest,
    status_code: u16,
    response_headers: &HeaderMap,
    response_body: &[u8],
) -> Result<Option<BreakpointResolution>, String> {
    let bp = match breakpoint_manager {
        Some(bp) => bp,
        None => return Ok(None),
    };

    if !bp.should_break(&BreakpointStage::Response, request.method.as_str(), request.url.as_str()) {
        return Ok(None);
    }

    let session_id = request.request_id.clone();
    let receiver = bp.register_pending(session_id.clone());

    let hit = build_response_stage_hit(request, status_code, response_headers, response_body);
    emit_log(
        "INFO",
        "breakpoint_response_stage_hit",
        &[
            ("session_id", session_id.clone()),
            ("method", request.method.to_string()),
            ("url", request.url.to_string()),
            ("status_code", status_code.to_string()),
        ],
    );
    emit_breakpoint_event(event_emitter, &hit);

    match receiver.await {
        Ok(resolution) => Ok(Some(resolution)),
        Err(_) => {
            emit_log(
                "WARN",
                "breakpoint_response_cancelled",
                &[("session_id", session_id)],
            );
            Err("breakpoint cancelled (proxy may have stopped)".to_string())
        }
    }
}

/// Apply a response-stage resolution to modify the upstream response.
fn apply_response_resolution(
    resolution: &BreakpointResolution,
    upstream_response: &mut UpstreamResponse,
) {
    if let Some(ref headers) = resolution.modified_response_headers {
        let mut new_headers = HeaderMap::new();
        for entry in headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(entry.name.as_bytes()),
                HeaderValue::from_str(&entry.value),
            ) {
                new_headers.insert(name, value);
            }
        }
        upstream_response.response_headers = new_headers;
    }
    if let Some(ref body_b64) = resolution.modified_response_body_base64 {
        upstream_response.response_body = BASE64_STANDARD
            .decode(body_b64)
            .unwrap_or_else(|_| body_b64.as_bytes().to_vec());
    }
}

/// Build a mock UpstreamResponse from user-provided mock data.
fn build_mock_upstream_response(mock: &MockResponse) -> UpstreamResponse {
    let body = mock
        .body_base64
        .as_deref()
        .map(|b| BASE64_STANDARD.decode(b).unwrap_or_else(|_| b.as_bytes().to_vec()))
        .unwrap_or_default();
    let mut headers = HeaderMap::new();
    for entry in &mock.headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(entry.name.as_bytes()),
            HeaderValue::from_str(&entry.value),
        ) {
            headers.insert(name, value);
        }
    }
    // Ensure content-length matches body
    headers.insert(CONTENT_LENGTH, HeaderValue::from_str(&body.len().to_string()).unwrap_or_else(|_| HeaderValue::from_static("0")));
    UpstreamResponse {
        response_body: body,
        response_headers: headers,
        response_read_ms: 0,
        status_code: StatusCode::from_u16(mock.status_code).unwrap_or(StatusCode::OK),
        waiting_ms: 0,
    }
}

pub async fn start_proxy_server(
    config: ProxyRuntimeConfig,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<StartedProxyServer, String> {
    config.validate().map_err(str::to_string)?;

    let bind_addr : &str = "0.0.0.0";
    let listener = TcpListener::bind((bind_addr, config.port))
        .await
        .map_err(|error| format!("failed to bind proxy listener on {bind_addr}:{}: {error}", config.port))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("failed to read proxy listener address: {error}"))?
        .port();

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
    let client = Arc::new(client);

    let (shutdown_sender, mut shutdown_receiver) = oneshot::channel::<()>();
    let (session_sender, session_receiver) = mpsc::unbounded_channel();

    emit_log(
        "INFO",
        "listener_started",
        &[
            ("host", bind_addr.to_string()),
            ("port", bound_port.to_string()),
            ("ssl_enabled", config.ssl_enabled.to_string()),
        ],
    );

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_receiver => {
                    emit_log(
                        "INFO",
                        "listener_stopped",
                        &[("reason", "shutdown_requested".to_string())],
                    );
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, client_addr)) => {
                            let client = Arc::clone(&client);
                            let session_sender = session_sender.clone();
                            let tls_manager = tls_manager.clone();
                            let breakpoint_manager = breakpoint_manager.clone();
                            let event_emitter = event_emitter.clone();

                            tokio::spawn(async move {
                                if let Err(error) = handle_connection(stream, client_addr, client, session_sender, tls_manager, breakpoint_manager, event_emitter).await {
                                    emit_log(
                                        "ERROR",
                                        "connection_failed",
                                        &[
                                            ("client_addr", client_addr.to_string()),
                                            ("error", error),
                                        ],
                                    );
                                }
                            });
                        }
                        Err(error) => {
                            emit_log(
                                "ERROR",
                                "listener_accept_failed",
                                &[("error", error.to_string())],
                            );
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(StartedProxyServer {
        bound_port,
        server_handle: ProxyServerHandle {
            shutdown_sender: Some(shutdown_sender),
            join_handle,
        },
        session_receiver,
    })
}

async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    client: Arc<Client>,
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<(), String> {
    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let mut request = match read_proxy_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_REQUEST,
                "Unable to parse the HTTP proxy request.",
            )
            .await?;

            emit_log(
                "WARN",
                "request_parse_failed",
                &[
                    ("client_addr", client_addr.to_string()),
                    ("error", error),
                ],
            );

            return Ok(());
        }
    };

    // Serve root CA certificate for mobile device download.
    // Mobile browsers hit http://<local-ip>:<port>/pharles-ca.crt directly (no proxy config yet).
    if request.method == Method::GET
        && (request.path == "/pharles-ca.crt" || request.path == "/pharles-ca.pem")
    {
        if let Some(ref mgr) = tls_manager {
            let cert_pem = mgr.root_ca.cert_pem();
            emit_log(
                "INFO",
                "cert_served",
                &[
                    ("client_addr", client_addr.to_string()),
                    ("path", request.path.clone()),
                ],
            );

            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/x-x509-ca-cert\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                cert_pem.len(),
                cert_pem
            );
            stream.write_all(response.as_bytes()).await.map_err(|e| format!("cert write: {e}"))?;
            let _ = stream.shutdown().await;
            return Ok(());
        } else {
            write_plain_text_response(
                &mut stream,
                StatusCode::NOT_FOUND,
                "No root certificate available. Enable SSL and generate a certificate first.",
            )
            .await?;
            return Ok(());
        }
    }

    if request.method == Method::CONNECT {
        let host = request.host.clone();
        let port: u16 = request.path.parse().unwrap_or(443);

        emit_log(
            "INFO",
            "connect_received",
            &[
                ("request_id", request.request_id.clone()),
                ("client_addr", client_addr.to_string()),
                ("host", host.clone()),
                ("port", port.to_string()),
                ("ssl_interception_enabled", tls_manager.is_some().to_string()),
            ],
        );

        match tls_manager {
            None => {
                emit_log(
                    "WARN",
                    "connect_tunneling_without_mitm",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // No TLS manager — blind tunnel (no decryption)
                return tunnel_blind_relay(stream, &host, port).await;
            }
            Some(mgr) => {
                emit_log(
                    "INFO",
                    "connect_mitm_started",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // MITM: TLS terminate, capture, forward
                return handle_connect_mitm(
                    stream,
                    host,
                    port,
                    mgr,
                    client,
                    session_sender,
                    started_at,
                    started_at_instant,
                    breakpoint_manager,
                    event_emitter,
                )
                .await;
            }
        }
    }

    // --- Request-stage breakpoint ---
    if let Some(resolution) = intercept_request_stage(&breakpoint_manager, &event_emitter, &mut request).await? {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    let mock_response = build_mock_upstream_response(mock);
                    write_upstream_response(
                        &mut stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let detail = build_session_detail(
                        &request,
                        mock_response.status_code.as_u16(),
                        &mock_response.response_headers,
                        &mock_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(0),
                            tls_ms: None,
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                    );
                    let _ = session_sender.send(detail);
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {
                // Modifications already applied inside intercept_request_stage
            }
        }
    }

    let pending_detail = build_pending_session_detail(&request, started_at);
    let _ = session_sender.send(pending_detail);

    match forward_request(&client, &request).await {
        Ok(mut upstream_response) => {
            // --- Response-stage breakpoint ---
            if let Some(resolution) = intercept_response_stage(
                &breakpoint_manager,
                &event_emitter,
                &request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
            .await?
            {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let _ = stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                        }
                    }
                    BreakpointActionKind::Forward => {
                        apply_response_resolution(&resolution, &mut upstream_response);
                    }
                }
            }

            write_upstream_response(
                &mut stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
                .await?;

            let detail = build_session_detail(
                &request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            let _ = session_sender.send(detail);

            emit_log(
                "INFO",
                "request_forwarded",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", request.url.to_string()),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream server.";

            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            let _ = session_sender.send(detail);
            emit_log(
                "ERROR",
                "upstream_request_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("url", request.url.to_string()),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream request failed: {error}"))
        }
    }
}

fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let timestamp = Utc::now().to_rfc3339();
    let mut line = format!("timestamp={timestamp} level={level} component=proxy-core event={event}");

    for (name, value) in fields {
        line.push(' ');
        line.push_str(name);
        line.push('=');
        line.push_str(&quote_value(value));
    }

    eprintln!("{line}");
    append_to_log_file(&line);
}

fn append_to_log_file(line: &str) {
    let write_lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _write_guard = write_lock.lock().expect("proxy-core log mutex should not be poisoned");
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn resolve_log_file_path() -> PathBuf {
    if let Ok(log_file) = env::var(DEV_LOG_ENV_VAR) {
        if !log_file.trim().is_empty() {
            return PathBuf::from(log_file);
        }
    }

    discover_workspace_root_from_current_exe()
        .unwrap_or_else(|| env::temp_dir().join("pharles-dev"))
        .join("logs")
        .join("dev")
        .join(DEV_LOG_FILE_NAME)
}

fn discover_workspace_root_from_current_exe() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;

    for ancestor in current_exe.ancestors() {
        if ancestor.file_name() == Some(OsStr::new("target")) {
            return ancestor.parent().map(Path::to_path_buf);
        }
    }

    None
}

fn quote_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");

    format!("\"{escaped}\"")
}

async fn forward_request(
    client: &Client,
    request: &ParsedProxyRequest,
) -> Result<UpstreamResponse, String> {
    emit_log(
        "INFO",
        "upstream_request_started",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
        ],
    );

    let mut request_builder = client.request(request.method.clone(), request.url.clone());
    request_builder = request_builder.headers(request.headers.clone());

    if !request.body.is_empty() {
        request_builder = request_builder.body(request.body.clone());
    }

    let waiting_started_at = Instant::now();
    let response = request_builder
        .send()
        .await
        .map_err(|error| {
            emit_log(
                "ERROR",
                "upstream_request_send_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("method", request.method.to_string()),
                    ("scheme", request.url.scheme().to_string()),
                    ("host", request.host.clone()),
                    ("url", request.url.to_string()),
                    ("error", error.to_string()),
                ],
            );
            format!("failed to send upstream request: {error}")
        })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();
    let status_code = response.status();
    let response_headers = response.headers().clone();
    let response_read_started_at = Instant::now();
    let response_body = response
        .bytes()
        .await
        .map_err(|error| {
            emit_log(
                "ERROR",
                "upstream_response_read_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("method", request.method.to_string()),
                    ("scheme", request.url.scheme().to_string()),
                    ("host", request.host.clone()),
                    ("url", request.url.to_string()),
                    ("status_code", status_code.as_u16().to_string()),
                    ("error", error.to_string()),
                ],
            );
            format!("failed to read upstream response body: {error}")
        })?
        .to_vec();
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    emit_log(
        "INFO",
        "upstream_request_succeeded",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
            ("status_code", status_code.as_u16().to_string()),
            ("waiting_ms", waiting_ms.to_string()),
            ("response_read_ms", response_read_ms.to_string()),
        ],
    );

    Ok(UpstreamResponse {
        response_body,
        response_headers,
        response_read_ms,
        status_code,
        waiting_ms,
    })
}

/// Blind TCP relay for CONNECT when SSL interception is disabled.
async fn tunnel_blind_relay(
    mut client_stream: TcpStream,
    host: &str,
    port: u16,
) -> Result<(), String> {
    // Send 200 Connection Established
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    let mut upstream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("failed to connect to upstream {host}:{port}: {e}"))?;

    // Bidirectional copy
    let (mut cr, mut cw) = client_stream.split();
    let (mut ur, mut uw) = upstream.split();

    let client_to_upstream = tokio::io::copy(&mut cr, &mut uw);
    let upstream_to_client = tokio::io::copy(&mut ur, &mut cw);

    tokio::select! {
        r = client_to_upstream => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_client_to_upstream_error", &[("error", e.to_string())]);
            }
        }
        r = upstream_to_client => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_upstream_to_client_error", &[("error", e.to_string())]);
            }
        }
    }

    Ok(())
}

/// HTTPS MITM: terminate TLS, capture decrypted traffic, forward upstream.
async fn handle_connect_mitm(
    mut stream: TcpStream,
    host: String,
    port: u16,
    tls_manager: Arc<TlsManager>,
    client: Arc<Client>,
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<(), String> {
    // Send 200 Connection Established
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    // TLS handshake
    let tls_acceptor = tokio_rustls::TlsAcceptor::from(tls_manager.server_config.clone());
    let tls_stream = match tls_acceptor.accept(stream).await {
        Ok(stream) => stream,
        Err(error) => {
            emit_log(
                "ERROR",
                "tls_handshake_failed",
                &[
                    ("host", host.clone()),
                    ("port", port.to_string()),
                    ("error", error.to_string()),
                ],
            );
            return Err(format!("TLS handshake failed for {host}:{port}: {error}"));
        }
    };

    emit_log(
        "INFO",
        "tls_handshake_succeeded",
        &[
            ("host", host.clone()),
            ("port", port.to_string()),
        ],
    );

    let tls_instant = Instant::now();
    let mut tls_stream = tls_stream;

    // Read the decrypted HTTP request from the TLS stream
    let request = match read_proxy_request_from_stream(&mut tls_stream).await {
        Ok(r) => r,
        Err(error) => {
            emit_log(
                "WARN",
                "tls_request_parse_failed",
                &[
                    ("host", host.clone()),
                    ("error", error),
                ],
            );
            return Ok(());
        }
    };

    let tls_ms = tls_instant.elapsed().as_millis();

    // Rewrite URL to https://
    let https_url = if request.url.scheme() == "http" {
        let mut https = format!("https://{host}:{port}");
        if !request.path.is_empty() && request.path != "/" {
            https.push_str(&request.path);
        } else {
            https.push('/');
        }
        https
    } else {
        request.url.to_string()
    };

    // Build a modified request for HTTPS upstream
    let mut https_request = ParsedProxyRequest {
        protocol: "https".to_string(),
        url: Url::parse(&https_url)
            .map_err(|e| format!("invalid https URL {https_url}: {e}"))?,
        ..request
    };

    // --- Request-stage breakpoint (HTTPS) ---
    if let Some(resolution) = intercept_request_stage(&breakpoint_manager, &event_emitter, &mut https_request).await? {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = tls_stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    let mock_response = build_mock_upstream_response(mock);
                    write_upstream_response(
                        &mut tls_stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let detail = build_session_detail(
                        &https_request,
                        mock_response.status_code.as_u16(),
                        &mock_response.response_headers,
                        &mock_response.response_body,
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: Some(0),
                            response_read_ms: Some(0),
                            tls_ms: Some(tls_ms),
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                    );
                    let _ = session_sender.send(detail);
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {}
        }
    }

    let pending_detail = build_pending_session_detail(&https_request, started_at);
    let _ = session_sender.send(pending_detail);

    // Forward upstream
    match forward_request(&client, &https_request).await {
        Ok(mut upstream_response) => {
            // --- Response-stage breakpoint (HTTPS) ---
            if let Some(resolution) = intercept_response_stage(
                &breakpoint_manager,
                &event_emitter,
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
            .await?
            {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let _ = tls_stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                        }
                    }
                    BreakpointActionKind::Forward => {
                        apply_response_resolution(&resolution, &mut upstream_response);
                    }
                }
            }

            write_upstream_response(
                &mut tls_stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
                .await?;

            let detail = build_session_detail(
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            let _ = session_sender.send(detail);

            emit_log(
                "INFO",
                "https_request_forwarded",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("method", https_request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", https_url),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream HTTPS server.";

            write_plain_text_response(
                &mut tls_stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &https_request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            let _ = session_sender.send(detail);

            emit_log(
                "ERROR",
                "https_upstream_request_failed",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("url", https_url),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream HTTPS request failed: {error}"))
        }
    }
}

async fn read_proxy_request(stream: &mut TcpStream) -> Result<ParsedProxyRequest, String> {
    read_proxy_request_from_stream(stream).await
}

async fn read_proxy_request_from_stream<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<ParsedProxyRequest, String> {
    let mut buffer = Vec::with_capacity(READ_BUFFER_BYTES);
    let mut chunk = vec![0_u8; READ_BUFFER_BYTES];
    let header_end = loop {
        let bytes_read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read from client stream: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before sending headers".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if buffer.len() > MAX_HEADER_BYTES {
            return Err("request headers exceed the maximum supported size".to_string());
        }

        if let Some(header_end) = find_header_end(&buffer) {
            break header_end;
        }
    };

    let mut headers = [EMPTY_HEADER; 64];
    let mut request = Request::new(&mut headers);
    let parse_status = request
        .parse(&buffer[..header_end])
        .map_err(|error| format!("failed to parse request line and headers: {error}"))?;

    if parse_status != Status::Complete(header_end) {
        return Err("request headers are incomplete".to_string());
    }

    let method = Method::from_bytes(
        request
            .method
            .ok_or_else(|| "request method is missing".to_string())?
            .as_bytes(),
    )
    .map_err(|error| format!("unsupported HTTP method: {error}"))?;
    let raw_path = request
        .path
        .ok_or_else(|| "request target is missing".to_string())?
        .to_string();
    let target_url = if method == Method::CONNECT {
        format!("http://{raw_path}")
    } else {
        resolve_target_url(&raw_path, request.headers)?
    };
    let url =
        Url::parse(&target_url).map_err(|error| format!("invalid proxy target URL: {error}"))?;
    let body_length = read_content_length(request.headers)?;
    let headers = build_upstream_headers(request.headers)?;
    let request_headers = build_header_entries_from_httparse_headers(request.headers);
    let host = url
        .host_str()
        .ok_or_else(|| "target URL does not contain a host".to_string())?
        .to_string();
    let path = if method == Method::CONNECT {
        raw_path.clone()
    } else {
        build_request_path(&url)
    };
    let protocol = if method == Method::CONNECT {
        "connect".to_string()
    } else {
        url.scheme().to_string()
    };
    let query_params = build_query_params(&url);
    let request_version = request.version.unwrap_or(1);

    drop(request);

    while buffer.len() < header_end + body_length {
        let bytes_read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read request body: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before request body was fully received".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
    }
    let body = buffer[header_end..header_end + body_length].to_vec();
    let raw_request = build_raw_http_message(
        &format!(
            "{} {} HTTP/1.{}",
            method.as_str(),
            raw_path,
            request_version,
        ),
        &request_headers,
        &body,
    );

    Ok(ParsedProxyRequest {
        body,
        headers,
        host,
        method,
        path,
        protocol,
        query_params,
        raw_request,
        request_headers,
        request_id: Uuid::new_v4().to_string(),
        url,
    })
}

fn resolve_target_url(
    raw_target: &str,
    headers: &[httparse::Header<'_>],
) -> Result<String, String> {
    if raw_target.starts_with("http://") || raw_target.starts_with("https://") {
        return Ok(raw_target.to_string());
    }

    let host = headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("host"))
        .map(|header| String::from_utf8_lossy(header.value).trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "host header is required for origin-form requests".to_string())?;

    Ok(format!("http://{host}{raw_target}"))
}

fn build_upstream_headers(headers: &[httparse::Header<'_>]) -> Result<HeaderMap, String> {
    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(header.name) {
            continue;
        }

        let header_name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|error| format!("invalid header name: {error}"))?;
        let header_value = HeaderValue::from_bytes(header.value)
            .map_err(|error| format!("invalid header value: {error}"))?;

        header_map.append(header_name, header_value);
    }

    Ok(header_map)
}

fn should_skip_request_header(header_name: &str) -> bool {
    header_name.eq_ignore_ascii_case(HOST.as_str())
        || header_name.eq_ignore_ascii_case(CONNECTION.as_str())
        || header_name.eq_ignore_ascii_case("proxy-connection")
        || header_name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || header_name.eq_ignore_ascii_case(TRANSFER_ENCODING.as_str())
}

fn should_skip_response_header(header_name: &HeaderName) -> bool {
    header_name == &CONNECTION
        || header_name == &CONTENT_LENGTH
        || header_name == &TRANSFER_ENCODING
}

fn read_content_length(headers: &[httparse::Header<'_>]) -> Result<usize, String> {
    let Some(header) = headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str()))
    else {
        return Ok(0);
    };

    String::from_utf8_lossy(header.value)
        .trim()
        .parse::<usize>()
        .map_err(|error| format!("invalid content-length header: {error}"))
}

fn build_request_path(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

fn build_session_detail(
    request: &ParsedProxyRequest,
    status_code: u16,
    response_headers: &HeaderMap,
    response_body: &[u8],
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    timing: ProxyTimingBreakdown,
) -> ProxySessionDetail {
    let id = request.request_id.clone();
    let response_header_entries = build_header_entries_from_map(response_headers);
    let summary = build_session_summary(
        id.clone(),
        request.method.to_string(),
        request.host.clone(),
        request.path.clone(),
        request.protocol.clone(),
        request.url.to_string(),
        status_code,
        response_body.len(),
        response_headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        started_at,
        started_at_instant,
    );

    let response_body_decoded = decode_body_bytes(
        response_body,
        response_headers.get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
    ).unwrap_or_else(|| response_body.to_vec());

    ProxySessionDetail {
        cookies: build_cookie_entries(&request.request_headers, &response_header_entries),
        id,
        query_params: request.query_params.clone(),
        raw_request: Some(request.raw_request.clone()),
        raw_response: Some(build_raw_http_message(
            &format!(
                "HTTP/1.1 {} {}",
                status_code,
                StatusCode::from_u16(status_code)
                    .ok()
                    .and_then(|code| code.canonical_reason().map(str::to_string))
                    .unwrap_or_else(|| "Unknown".to_string()),
            ),
            &response_header_entries,
            &response_body_decoded,
        )),
        request_body: build_body_reference(
            &request.body,
            request.headers.get(CONTENT_TYPE),
            request.headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        request_headers: request.request_headers.clone(),
        response_body: build_body_reference(
            response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        response_headers: response_header_entries,
        server_ip: None,
        summary,
        timing: Some(timing),
    }
}

fn build_pending_session_detail(
    request: &ParsedProxyRequest,
    started_at: DateTime<Utc>,
) -> ProxySessionDetail {
    let started_at_text = started_at.to_rfc3339();

    ProxySessionDetail {
        cookies: Vec::new(),
        id: request.request_id.clone(),
        query_params: request.query_params.clone(),
        raw_request: Some(request.raw_request.clone()),
        raw_response: None,
        request_body: build_body_reference(
            &request.body,
            request.headers.get(CONTENT_TYPE),
            request.headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        request_headers: request.request_headers.clone(),
        response_body: None,
        response_headers: Vec::new(),
        server_ip: None,
        summary: ProxySessionSummary {
            id: request.request_id.clone(),
            method: request.method.to_string(),
            host: request.host.clone(),
            path: request.path.clone(),
            protocol: request.protocol.clone(),
            started_at: started_at_text.clone(),
            finished_at: started_at_text,
            duration_ms: 0,
            size_bytes: 0,
            status_code: 0,
            url: request.url.to_string(),
            response_mime_type: None,
        },
        timing: Some(ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: None,
            tls_ms: None,
            total_ms: Some(0),
            waiting_ms: None,
        }),
    }
}

fn build_header_entries_from_httparse_headers(
    headers: &[httparse::Header<'_>],
) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name.to_string(),
            value: String::from_utf8_lossy(header.value).trim().to_string(),
        })
        .collect()
}

fn build_header_entries_from_map(headers: &HeaderMap) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.as_str().to_string(),
            value: value
                .to_str()
                .map(str::to_string)
                .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).to_string()),
        })
        .collect()
}

fn build_query_params(url: &Url) -> Vec<ProxyHeaderEntry> {
    url.query_pairs()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect()
}

fn build_cookie_entries(
    request_headers: &[ProxyHeaderEntry],
    response_headers: &[ProxyHeaderEntry],
) -> Vec<ProxyHeaderEntry> {
    request_headers
        .iter()
        .chain(response_headers.iter())
        .filter(|header| {
            header.name.eq_ignore_ascii_case("cookie")
                || header.name.eq_ignore_ascii_case("set-cookie")
        })
        .cloned()
        .collect()
}

fn build_body_reference(
    body: &[u8],
    content_type_header: Option<&HeaderValue>,
    content_encoding_header: Option<&HeaderValue>,
) -> Option<ProxyBodyReference> {
    if body.is_empty() {
        return None;
    }

    let mime_type = content_type_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    let content_encoding = content_encoding_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    // Decode the full body before generating text so compressed streams are never broken.
    let decoded_body = decode_body_bytes(body, content_encoding.as_deref()).unwrap_or_else(|| body.to_vec());

    let inline_text = if should_render_body_as_text(mime_type.as_deref(), &decoded_body) {
        Some(String::from_utf8_lossy(&decoded_body).to_string())
    } else {
        None
    };

    Some(ProxyBodyReference {
        base64_text: Some(BASE64_STANDARD.encode(&decoded_body)),
        encoding: inline_text.as_ref().map(|_| "utf-8".to_string()),
        inline_text,
        mime_type,
        size_bytes: body.len(),
        truncated: false,
    })
}

fn should_render_body_as_text(mime_type: Option<&str>, body: &[u8]) -> bool {
    if let Some(mime_type) = mime_type {
        let lowered = mime_type.to_ascii_lowercase();
        if lowered.starts_with("text/")
            || lowered.contains("json")
            || lowered.contains("xml")
            || lowered.contains("javascript")
            || lowered.contains("yaml")
            || lowered.contains("x-www-form-urlencoded")
        {
            return true;
        }
    }

    std::str::from_utf8(body).is_ok()
}

fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Option<Vec<u8>> {
    let encoding = content_encoding?;

    if encoding.contains("gzip") {
        let mut decoder = GzDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    if encoding.contains("deflate") {
        let mut decoder = ZlibDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    if encoding.contains("br") {
        let mut decoder = Decompressor::new(Cursor::new(body), 4096);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    None
}

fn build_raw_http_message(
    start_line: &str,
    headers: &[ProxyHeaderEntry],
    body: &[u8],
) -> String {
    let mut raw_message = String::new();
    raw_message.push_str(start_line);
    raw_message.push_str("\r\n");

    for header in headers {
        raw_message.push_str(&header.name);
        raw_message.push_str(": ");
        raw_message.push_str(&header.value);
        raw_message.push_str("\r\n");
    }

    raw_message.push_str("\r\n");

    if !body.is_empty() {
        raw_message.push_str(&String::from_utf8_lossy(body));
    }

    raw_message
}

fn build_session_summary(
    id: String,
    method: String,
    host: String,
    path: String,
    protocol: String,
    url: String,
    status_code: u16,
    size_bytes: usize,
    response_mime_type: Option<String>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> ProxySessionSummary {
    ProxySessionSummary {
        id,
        method,
        host,
        path,
        protocol,
        started_at: started_at.to_rfc3339(),
        finished_at: Utc::now().to_rfc3339(),
        duration_ms: started_at_instant.elapsed().as_millis(),
        size_bytes,
        status_code,
        url,
        response_mime_type,
    }
}

async fn write_upstream_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    status_code: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), String> {
    let reason = status_code.canonical_reason().unwrap_or("Unknown");
    let mut response = format!("HTTP/1.1 {} {reason}\r\n", status_code.as_u16());

    for (header_name, header_value) in headers {
        if should_skip_response_header(header_name) {
            continue;
        }

        let header_value = header_value
            .to_str()
            .map_err(|error| format!("response header value is not valid UTF-8: {error}"))?;

        response.push_str(header_name.as_str());
        response.push_str(": ");
        response.push_str(header_value);
        response.push_str("\r\n");
    }

    response.push_str(&format!("Content-Length: {}\r\n", body.len()));
    response.push_str("Connection: close\r\n\r\n");

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(map_io_error)?;

    if !body.is_empty() {
        stream.write_all(body).await.map_err(map_io_error)?;
    }

    stream.flush().await.map_err(map_io_error)?;

    Ok(())
}

async fn write_plain_text_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    status_code: StatusCode,
    message: &str,
) -> Result<(), String> {
    let reason = status_code.canonical_reason().unwrap_or("Unknown");
    let response = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code.as_u16(),
        message.len(),
        message
    );

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(map_io_error)?;
    stream.flush().await.map_err(map_io_error)?;

    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn map_io_error(error: io::Error) -> String {
    format!("stream IO failure: {error}")
}

/// Send a direct HTTP request (used by Compose / Repeat).
/// Returns a full `ProxySessionDetail` so the frontend can reuse the
/// same inspector components that render captured proxy sessions.
pub async fn send_direct_request(
    method: String,
    url: String,
    headers: Vec<ProxyHeaderEntry>,
    body: Option<String>,
) -> Result<ProxySessionDetail, String> {
    let request_method = Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("invalid HTTP method '{method}': {e}"))?;
    let request_url = Url::parse(&url)
        .map_err(|e| format!("invalid URL '{url}': {e}"))?;

    let host = request_url
        .host_str()
        .ok_or_else(|| format!("URL '{url}' does not contain a host"))?
        .to_string();
    let path = build_request_path(&request_url);
    let protocol = request_url.scheme().to_string();
    let query_params = build_query_params(&request_url);
    let request_id = Uuid::new_v4().to_string();

    // Build header map, skipping hop-by-hop headers
    let mut header_map = HeaderMap::new();
    for header in &headers {
        if should_skip_request_header(&header.name) {
            continue;
        }
        let header_name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|e| format!("invalid header name '{}': {e}", header.name))?;
        let header_value = HeaderValue::from_str(&header.value)
            .map_err(|e| format!("invalid header value for '{}': {e}", header.name))?;
        header_map.append(header_name, header_value);
    }

    let body_bytes = body
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(|b| b.as_bytes().to_vec())
        .unwrap_or_default();

    let raw_request = build_raw_http_message(
        &format!("{method} {path} HTTP/1.1"),
        &headers,
        &body_bytes,
    );

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    let mut request_builder = client.request(request_method.clone(), request_url.clone());
    request_builder = request_builder.headers(header_map.clone());

    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.clone());
    }

    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let waiting_started_at = Instant::now();
    let response = request_builder.send().await.map_err(|e| {
        format!("failed to send request to '{url}': {e}")
    })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    let status_code = response.status();
    let response_headers = response.headers().clone();

    let response_read_started_at = Instant::now();
    let response_body = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?
        .to_vec();
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    emit_log(
        "INFO",
        "direct_request_completed",
        &[
            ("request_id", request_id.clone()),
            ("method", method.clone()),
            ("url", url.clone()),
            ("status_code", status_code.as_u16().to_string()),
            ("waiting_ms", waiting_ms.to_string()),
            ("response_read_ms", response_read_ms.to_string()),
        ],
    );

    let timing = ProxyTimingBreakdown {
        connect_ms: None,
        dns_ms: None,
        request_send_ms: None,
        response_read_ms: Some(response_read_ms),
        tls_ms: None,
        total_ms: Some(started_at_instant.elapsed().as_millis()),
        waiting_ms: Some(waiting_ms),
    };

    let id = Uuid::new_v4().to_string();
    let response_header_entries = build_header_entries_from_map(&response_headers);
    let response_mime_type = response_headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let summary = build_session_summary(
        id.clone(),
        method,
        host,
        path,
        protocol,
        url,
        status_code.as_u16(),
        response_body.len(),
        response_mime_type,
        started_at,
        started_at_instant,
    );

    let response_body_decoded = decode_body_bytes(
        &response_body,
        response_headers.get(reqwest::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
    ).unwrap_or_else(|| response_body.clone());

    Ok(ProxySessionDetail {
        cookies: build_cookie_entries(&headers, &response_header_entries),
        id,
        query_params,
        raw_request: Some(raw_request),
        raw_response: Some(build_raw_http_message(
            &format!(
                "HTTP/1.1 {} {}",
                status_code.as_u16(),
                status_code.canonical_reason().unwrap_or("Unknown"),
            ),
            &response_header_entries,
            &response_body_decoded,
        )),
        request_body: build_body_reference(
            &body_bytes,
            header_map.get(CONTENT_TYPE),
            header_map.get(reqwest::header::CONTENT_ENCODING),
        ),
        request_headers: headers,
        response_body: build_body_reference(
            &response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        response_headers: response_header_entries,
        server_ip: None,
        summary,
        timing: Some(timing),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_request_path, find_header_end, resolve_target_url, start_proxy_server,
        ProxyRuntimeConfig,
    };
    use reqwest::Url;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    #[test]
    fn validates_a_non_zero_port() {
        let config = ProxyRuntimeConfig {
            port: 8888,
            ssl_enabled: true,
        };

        let actual = config.validate();

        assert_eq!(actual, Ok(()));
    }

    #[test]
    fn rejects_zero_as_a_port() {
        let config = ProxyRuntimeConfig {
            port: 0,
            ssl_enabled: false,
        };

        let actual = config.validate();

        assert_eq!(actual, Err("proxy port must be greater than zero"));
    }

    #[test]
    fn finds_the_end_of_the_http_header_block() {
        let actual = find_header_end(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\nbody");

        assert_eq!(actual, Some(37));
    }

    #[test]
    fn resolves_origin_form_requests_from_the_host_header() {
        let headers = [httparse::Header {
            name: "Host",
            value: b"example.com",
        }];

        let actual = resolve_target_url("/hello", &headers);

        assert_eq!(actual, Ok("http://example.com/hello".to_string()));
    }

    #[test]
    fn keeps_absolute_form_requests_unchanged() {
        let actual = resolve_target_url("http://example.com/hello", &[]);

        assert_eq!(actual, Ok("http://example.com/hello".to_string()));
    }

    #[test]
    fn builds_a_request_path_with_the_query_string() {
        let actual = build_request_path(&Url::parse("http://example.com/hello?lang=en").unwrap());

        assert_eq!(actual, "/hello?lang=en");
    }

    #[tokio::test]
    async fn forwards_plain_http_requests_and_emits_a_session_detail() {
        let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = upstream_listener.local_addr().unwrap().port();
        let upstream_task = tokio::spawn(async move {
            let (mut stream, _) = upstream_listener.accept().await.unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHello",
                )
                .await
                .unwrap();
        });

        let proxy_port = allocate_unused_port();
        let mut started_proxy = start_proxy_server(
            ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
            },
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let target_url = format!("http://127.0.0.1:{upstream_port}/hello");
        let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        let request = format!(
            "GET {target_url} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nConnection: close\r\n\r\n"
        );
        client_stream.write_all(request.as_bytes()).await.unwrap();

        let mut response = String::new();
        client_stream.read_to_string(&mut response).await.unwrap();
        let session = started_proxy.session_receiver.recv().await.unwrap();

        assert!(response.contains("HTTP/1.1 200 OK"));
        assert!(response.contains("Hello"));
        assert_eq!(session.summary.method, "GET");
        assert_eq!(session.summary.host, "127.0.0.1");
        assert_eq!(session.summary.path, "/hello");
        assert_eq!(session.summary.status_code, 200);
        assert_eq!(
            session.request_headers[0].name.to_ascii_lowercase(),
            "host".to_string()
        );
        assert_eq!(
            session
                .response_body
                .as_ref()
                .and_then(|body| body.inline_text.clone()),
            Some("Hello".to_string())
        );

        started_proxy.server_handle.shutdown().await;
        upstream_task.await.unwrap();
    }

    fn allocate_unused_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
}
