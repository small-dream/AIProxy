use super::*;

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
    pub modified_request_query_params: Option<Vec<ProxyHeaderEntry>>,
    pub modified_request_body_base64: Option<String>,
    pub modified_response_status_code: Option<u16>,
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
    #[serde(default)]
    pub match_type: Option<String>,
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

fn refresh_request_target_from_url(request: &mut ParsedProxyRequest) {
    request.path = build_request_path(&request.url);
    request.query_params = build_query_params(&request.url);
    request.raw_request = build_raw_http_head(
        &format!("{} {} HTTP/1.1", request.method, request.path),
        &request.request_headers,
    );
}

fn strip_plain_body_edit_headers(headers: &mut HeaderMap) {
    // Breakpoint body editors operate on decoded/plain bytes. If the original
    // exchange was compressed or had body validators, those headers no longer
    // describe the replacement body.
    headers.remove("content-encoding");
    headers.remove("content-md5");
    headers.remove("digest");
    headers.remove("etag");
}

fn strip_plain_body_edit_header_entries(headers: &mut Vec<ProxyHeaderEntry>) {
    headers.retain(|entry| {
        !entry.name.eq_ignore_ascii_case("content-encoding")
            && !entry.name.eq_ignore_ascii_case("content-md5")
            && !entry.name.eq_ignore_ascii_case("digest")
            && !entry.name.eq_ignore_ascii_case("etag")
    });
}

pub(crate) fn apply_request_resolution(
    resolution: &BreakpointResolution,
    request: &mut ParsedProxyRequest,
) {
    if let Some(ref query_params) = resolution.modified_request_query_params {
        request.url.query_pairs_mut().clear().extend_pairs(
            query_params
                .iter()
                .map(|entry| (entry.name.as_str(), entry.value.as_str())),
        );
        refresh_request_target_from_url(request);
    }

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
        refresh_request_target_from_url(request);
    }

    if let Some(ref body_b64) = resolution.modified_request_body_base64 {
        request.body = BASE64_STANDARD
            .decode(body_b64)
            .unwrap_or_else(|_| body_b64.as_bytes().to_vec());
        strip_plain_body_edit_headers(&mut request.headers);
        strip_plain_body_edit_header_entries(&mut request.request_headers);
        refresh_request_target_from_url(request);
    }
}

/// Callback for emitting events from the proxy core to the frontend.
/// Keeps proxy-core framework-agnostic (no direct tauri dependency).
pub type BreakpointEventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

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
            .field(
                "pending_count",
                &self.pending.lock().map(|p| p.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl Default for BreakpointManager {
    fn default() -> Self {
        Self::new()
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
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_rules(&self, rules: Vec<BreakpointRule>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    /// Check whether any enabled rule matches the given stage/method/url.
    pub fn should_break(&self, stage: &BreakpointStage, method: &str, url: &str) -> bool {
        let rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.iter().any(|rule| {
            if !rule.enabled {
                return false;
            }
            if rule.stage != *stage {
                return false;
            }
            if !rule.methods.is_empty()
                && !rule.methods.iter().any(|m| m.eq_ignore_ascii_case(method))
            {
                return false;
            }
            crate::rules::pattern_matches(&rule.url_pattern, url, rule.match_type.as_deref())
        })
    }

    /// Register a pending breakpoint. Returns the receiver end that the proxy task will await.
    pub fn register_pending(&self, session_id: String) -> oneshot::Receiver<BreakpointResolution> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id, tx);
        rx
    }

    /// Resolve a pending breakpoint by sending the user's decision.
    pub fn resolve(
        &self,
        session_id: &str,
        resolution: BreakpointResolution,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = pending.remove(session_id) {
            sender.send(resolution).map_err(|_| {
                "failed to send breakpoint resolution — receiver already dropped".to_string()
            })
        } else {
            Err(format!(
                "no pending breakpoint found for session {session_id}"
            ))
        }
    }

    /// Cancel all pending breakpoints (e.g. when the proxy stops).
    pub fn cancel_all(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.clear();
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
        request_body: build_body_reference(
            &request.body,
            content_type,
            content_encoding,
            request.body.len(),
            false,
        ),
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
        request_body: build_body_reference(
            &request.body,
            req_content_type,
            req_content_encoding,
            request.body.len(),
            false,
        ),
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
        response_body: build_body_reference(
            response_body,
            resp_content_type,
            resp_content_encoding,
            response_body.len(),
            false,
        ),
    }
}

/// Emit a breakpoint-hit event through the event emitter callback.
fn emit_breakpoint_event(emitter: &Option<BreakpointEventEmitter>, hit: &BreakpointHit) {
    if let Some(ref emit) = emitter {
        let payload = serde_json::to_value(hit).unwrap_or_else(|e| {
            emit_log(
                "ERROR",
                "breakpoint_hit_serialize_failed",
                &[("error", e.to_string())],
            );
            serde_json::Value::Null
        });
        emit("breakpoint-hit", payload);
    }
}

/// Check for a request-stage breakpoint. If matched, emits the event, waits for resolution,
/// and returns the resolution. Returns `None` if no breakpoint rule matched.
pub(crate) async fn intercept_request_stage(
    breakpoint_manager: &Option<Arc<BreakpointManager>>,
    event_emitter: &Option<BreakpointEventEmitter>,
    request: &mut ParsedProxyRequest,
) -> Result<Option<BreakpointResolution>, String> {
    let bp = match breakpoint_manager {
        Some(bp) => bp,
        None => return Ok(None),
    };

    if !bp.should_break(
        &BreakpointStage::Request,
        request.method.as_str(),
        request.url.as_str(),
    ) {
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
            apply_request_resolution(&resolution, request);
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
pub(crate) async fn intercept_response_stage(
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

    if !bp.should_break(
        &BreakpointStage::Response,
        request.method.as_str(),
        request.url.as_str(),
    ) {
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
pub(crate) fn apply_response_resolution(
    resolution: &BreakpointResolution,
    upstream_response: &mut UpstreamResponse,
) {
    if let Some(status_code) = resolution.modified_response_status_code {
        if let Ok(status_code) = StatusCode::from_u16(status_code) {
            upstream_response.status_code = status_code;
        }
    }
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
        upstream_response.replace_response_body(
            BASE64_STANDARD
                .decode(body_b64)
                .unwrap_or_else(|_| body_b64.as_bytes().to_vec()),
        );
        strip_plain_body_edit_headers(&mut upstream_response.response_headers);
    }
}

/// Build a mock UpstreamResponse from user-provided mock data.
pub(crate) fn build_mock_upstream_response(mock: &MockResponse) -> UpstreamResponse {
    let body = mock
        .body_base64
        .as_deref()
        .map(|b| {
            BASE64_STANDARD
                .decode(b)
                .unwrap_or_else(|_| b.as_bytes().to_vec())
        })
        .unwrap_or_default();
    let body_len = body.len();
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
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body: body,
        response_body_size_bytes: body_len,
        response_headers: headers,
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::from_u16(mock.status_code).unwrap_or(StatusCode::OK),
        tls_ms: None,
        waiting_ms: 0,
    }
}
