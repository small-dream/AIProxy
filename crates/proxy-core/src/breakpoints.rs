use super::*;
use regex::Regex;

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

/// Why a pending breakpoint was released without a user resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BreakpointReleaseReason {
    Timeout,
    SenderDropped,
}

/// Payload pushed to the frontend when a pending breakpoint is released
/// without a user resolution (wait timeout or dropped sender). Without this
/// event the frontend keeps showing a hit whose request was already forwarded
/// unchanged (review §4.3 "black box").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointReleased {
    pub session_id: String,
    pub stage: BreakpointStage,
    pub reason: BreakpointReleaseReason,
}

fn refresh_request_target_from_url(request: &mut ParsedProxyRequest) {
    request.path = build_request_path(&request.url);
    request.query_params = build_query_params(&request.url);
    request.raw_request = build_raw_http_head(
        &format!("{} {} HTTP/1.1", request.method, request.path),
        &request.request_headers,
    );
}

/// M8: when a user edits the `Host` header in a breakpoint, propagate the new
/// host (and optional `:port`) back into `request.host` and `request.url` so
/// the change actually takes effect. The upstream connect path
/// (`upstream.rs:152-156`) builds the on-the-wire Host header from
/// `request.host`, and DNS/routing use `request.host` too — without this
/// write-back the edited Host header is silently ignored for routing. The Host
/// header value is `host`, `host:port`, `[ipv6]`, or `[ipv6]:port`; an invalid
/// value is ignored (the request keeps its original host) rather than failing
/// the edit, mirroring the forgiving posture of the rest of the breakpoint
/// pipeline.
///
/// The host and port are validated as a unit (parsed via `Url::set_host` +
/// `set_port`) BEFORE either `request.host` or `request.url` is mutated, so a
/// rejected value cannot leave `request.host` updated while `request.url`
/// keeps the old host (which would desynchronize routing from the URL).
fn apply_host_header_to_request(request: &mut ParsedProxyRequest, headers: &HeaderMap) {
    let Some(host_value) = headers.get("host") else {
        return;
    };
    let host_str = match host_value.to_str() {
        Ok(s) => s,
        Err(_) => return, // non-ASCII obs-text — leave host untouched
    };
    let host_str = host_str.trim();
    if host_str.is_empty() {
        return;
    }

    // Split the optional `:port` suffix robustly, including the bracketed IPv6
    // forms `[::1]` and `[::1]:8080`. A leading `[` means the host is a
    // bracketed IPv6 literal; the optional port (if any) follows the closing
    // `]`. Otherwise split on the last `:` only when the right side parses as
    // a u16 port; a non-numeric `:suffix` on a non-bracketed host is rejected
    // (a hostname cannot validly contain `:` outside an IPv6 literal).
    let (host_part, port_part, unbracketed_host): (String, Option<u16>, Option<String>) =
        if let Some(rest) = host_str.strip_prefix('[') {
            // Bracketed IPv6 form. Find the closing `]`; everything after `]:` is
            // the port. `host_part` keeps the brackets (so `request.host` round-
            // trips the literal the user typed) but `set_host` is given the
            // unbracketed form, which is what `Url::set_host` expects.
            match rest.find(']') {
                Some(close_idx) => {
                    // close_idx is the index of `]` within `rest` (which excludes
                    // the leading `[`). In `host_str` that `]` is at close_idx + 1.
                    let ipv6_with_brackets = &host_str[..=close_idx + 1]; // includes []
                    let inner = &rest[..close_idx]; // without []
                    let after = &rest[close_idx + 1..];
                    let port = after.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
                    if !after.is_empty() && port.is_none() {
                        return; // garbage after `]` that is not `:port` — reject
                    }
                    (
                        ipv6_with_brackets.to_string(),
                        port,
                        Some(inner.to_string()),
                    )
                }
                None => return, // unclosed `[` — reject
            }
        } else {
            // Plain host or `host:port`. Split on the last `:` only when the right
            // side is a valid u16 port. A non-numeric `:suffix` on a non-bracketed
            // host means the value is malformed — reject rather than treat the
            // whole thing (including the colon) as a hostname.
            match host_str.rsplit_once(':') {
                Some((h, p)) => match p.parse::<u16>() {
                    Ok(port) => (h.trim().to_string(), Some(port), None),
                    Err(_) => return,
                },
                None => (host_str.to_string(), None, None),
            }
        };

    if host_part.is_empty() {
        return;
    }

    // `Url::set_host` accepts either an unbracketed hostname or, for IPv6
    // literals, the bracketed `[...]` form. We always have the bracketed form
    // in `host_part` for IPv6, so prefer that; fall back to `host_part`
    // (already correct for plain hosts) otherwise.
    let host_for_url = unbracketed_host
        .as_ref()
        .map(|inner| format!("[{inner}]"))
        .unwrap_or_else(|| host_part.clone());

    // Validate by applying to a CLONE of the URL first. If `set_host`/`set_port`
    // reject the value, leave both `request.host` and `request.url` untouched.
    let mut candidate = request.url.clone();
    if candidate.set_host(Some(&host_for_url)).is_err() {
        return;
    }
    match port_part {
        Some(port) => {
            if candidate.set_port(Some(port)).is_err() {
                return;
            }
        }
        None => {
            // No explicit port in the header — clear any port so the URL uses
            // the default port for its scheme.
            let _ = candidate.set_port(None);
        }
    }

    // Validation passed — commit both fields atomically. `request.host` keeps
    // the form the user typed (with brackets for IPv6, matching how it appears
    // on the wire and in the session detail); `request.url` carries the parsed
    // host/port.
    request.host = host_part;
    request.url = candidate;
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
        // M8: if the user edited the Host header, write it back to
        // `request.host` / `request.url` BEFORE refreshing the request target,
        // so the change actually drives upstream routing and the rebuilt
        // raw_request reflects the new host.
        apply_host_header_to_request(request, &new_headers);
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

/// A pending breakpoint entry, tracking which rule triggered it.
struct PendingBreakpoint {
    rule_id: String,
    sender: oneshot::Sender<BreakpointResolution>,
}

/// Internal wrapper that pairs a breakpoint rule with a pre-compiled regex.
struct CompiledBreakpointRule {
    rule: BreakpointRule,
    compiled_match: Option<Regex>,
}

/// Manages active breakpoint rules and pending interceptions.
pub struct BreakpointManager {
    rules: std::sync::Mutex<Vec<CompiledBreakpointRule>>,
    pending: std::sync::Mutex<HashMap<String, PendingBreakpoint>>,
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
        self.rules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|c| c.rule.clone())
            .collect()
    }

    pub fn set_rules(&self, rules: Vec<BreakpointRule>) {
        // Compile regex patterns at insertion time.
        let compiled: Vec<CompiledBreakpointRule> = rules
            .into_iter()
            .map(|rule| {
                let compiled_match =
                    crate::rules::compile_match_regex(&rule.match_type, &rule.url_pattern);
                CompiledBreakpointRule {
                    rule,
                    compiled_match,
                }
            })
            .collect();

        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());

        // Collect IDs of currently active (enabled) rules before replacing.
        let old_active_ids: Vec<String> = guard
            .iter()
            .filter(|c| c.rule.enabled)
            .map(|c| c.rule.id.clone())
            .collect();

        // Identify active IDs that are no longer present or no longer enabled.
        let new_active_ids: HashSet<&str> = compiled
            .iter()
            .filter(|c| c.rule.enabled)
            .map(|c| c.rule.id.as_str())
            .collect();
        let removed_ids: Vec<String> = old_active_ids
            .into_iter()
            .filter(|id| !new_active_ids.contains(id.as_str()))
            .collect();

        *guard = compiled;

        // Release the rules lock before acquiring the pending lock.
        drop(guard);

        if !removed_ids.is_empty() {
            self.cancel_for_rules(&removed_ids);
        }
    }

    /// Check whether any enabled rule matches the given stage/method/url.
    pub fn should_break(&self, stage: &BreakpointStage, method: &str, url: &str) -> bool {
        let rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.iter().any(|cr| {
            let rule = &cr.rule;
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
            // Use pre-compiled regex for "regex" match type; fall back to
            // pattern_matches for other match types (exact/wildcard/contains).
            match rule.match_type.as_deref() {
                Some("regex") => cr
                    .compiled_match
                    .as_ref()
                    .is_some_and(|re| re.is_match(url)),
                _ => crate::rules::pattern_matches(
                    &rule.url_pattern,
                    url,
                    rule.match_type.as_deref(),
                ),
            }
        })
    }

    /// Find the ID of the first enabled rule matching the given stage/method/url.
    /// Returns None if no rule matches.
    fn find_matching_rule_id(
        &self,
        stage: &BreakpointStage,
        method: &str,
        url: &str,
    ) -> Option<String> {
        let rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules
            .iter()
            .find(|cr| {
                let rule = &cr.rule;
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
                // Use pre-compiled regex for "regex" match type.
                match rule.match_type.as_deref() {
                    Some("regex") => cr
                        .compiled_match
                        .as_ref()
                        .is_some_and(|re| re.is_match(url)),
                    _ => crate::rules::pattern_matches(
                        &rule.url_pattern,
                        url,
                        rule.match_type.as_deref(),
                    ),
                }
            })
            .map(|cr| cr.rule.id.clone())
    }

    /// Register a pending breakpoint. Returns the receiver end that the proxy task will await.
    pub fn register_pending(
        &self,
        session_id: String,
        rule_id: String,
    ) -> oneshot::Receiver<BreakpointResolution> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                session_id,
                PendingBreakpoint {
                    rule_id,
                    sender: tx,
                },
            );
        rx
    }

    /// Remove a pending breakpoint entry without sending a resolution.
    /// Used by the wait path when the sender is dropped or the wait times out,
    /// so the pending map does not leak stale entries.
    pub(crate) fn remove_pending(&self, session_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
    }

    /// Resolve a pending breakpoint by sending the user's decision.
    pub fn resolve(
        &self,
        session_id: &str,
        resolution: BreakpointResolution,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = pending.remove(session_id) {
            entry.sender.send(resolution).map_err(|_| {
                "failed to send breakpoint resolution — receiver already dropped".to_string()
            })
        } else {
            Err(format!(
                "no pending breakpoint found for session {session_id}"
            ))
        }
    }

    /// Cancel all pending breakpoints (e.g. when the proxy stops).
    /// Sends a Forward resolution to each waiter so the proxy can pass
    /// the request/response through unmodified instead of hard-erroring.
    pub fn cancel_all(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        for (_key, entry) in pending.drain() {
            let forward_resolution = BreakpointResolution {
                session_id: _key.clone(),
                action: BreakpointActionKind::Forward,
                mock: None,
                modified_request_headers: None,
                modified_request_query_params: None,
                modified_request_body_base64: None,
                modified_response_status_code: None,
                modified_response_headers: None,
                modified_response_body_base64: None,
            };
            let _ = entry.sender.send(forward_resolution);
        }
    }

    /// Returns whether a pending entry exists for the given session id.
    /// Test-only helper used to assert the pending map is cleaned on timeout
    /// or dropped-sender paths.
    #[cfg(test)]
    pub(crate) fn pending_contains(&self, session_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(session_id)
    }

    /// Cancel pending breakpoints that were triggered by specific rule IDs.
    /// Sends a Forward resolution so each waiter passes through unmodified.
    pub fn cancel_for_rules(&self, rule_ids: &[String]) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let keys_to_remove: Vec<_> = pending
            .iter()
            .filter(|(_, entry)| rule_ids.contains(&entry.rule_id))
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys_to_remove {
            if let Some(entry) = pending.remove(&key) {
                let forward_resolution = BreakpointResolution {
                    session_id: key.clone(),
                    action: BreakpointActionKind::Forward,
                    mock: None,
                    modified_request_headers: None,
                    modified_request_query_params: None,
                    modified_request_body_base64: None,
                    modified_response_status_code: None,
                    modified_response_headers: None,
                    modified_response_body_base64: None,
                };
                let _ = entry.sender.send(forward_resolution);
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
                    is_pseudo: None,
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
            tracing::error!(
                event = "breakpoint_hit_serialize_failed",
                error = %e,
                "breakpoint_hit_serialize_failed"
            );
            serde_json::Value::Null
        });
        emit("breakpoint-hit", payload);
    }
}

/// Emit a breakpoint-released event so the frontend can drop the pending hit
/// and tell the user the request was forwarded automatically.
fn emit_breakpoint_released(
    emitter: &Option<BreakpointEventEmitter>,
    session_id: &str,
    stage: BreakpointStage,
    reason: BreakpointReleaseReason,
) {
    if let Some(ref emit) = emitter {
        let released = BreakpointReleased {
            session_id: session_id.to_string(),
            stage,
            reason,
        };
        let payload = serde_json::to_value(&released).unwrap_or_else(|e| {
            tracing::error!(
                event = "breakpoint_released_serialize_failed",
                error = %e,
                "breakpoint_released_serialize_failed"
            );
            serde_json::Value::Null
        });
        emit("breakpoint-released", payload);
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

    let rule_id = match bp.find_matching_rule_id(
        &BreakpointStage::Request,
        request.method.as_str(),
        request.url.as_str(),
    ) {
        Some(id) => id,
        None => return Ok(None),
    };

    let session_id = request.request_id.clone();
    let receiver = bp.register_pending(session_id.clone(), rule_id);

    let hit = build_request_stage_hit(request);
    tracing::info!(
        event = "breakpoint_request_stage_hit",
        session_id = %session_id,
        method = %request.method,
        url = %request.url,
        "breakpoint_request_stage_hit"
    );
    emit_breakpoint_event(event_emitter, &hit);

    match tokio::time::timeout(crate::breakpoint_wait_timeout(), receiver).await {
        Ok(Ok(resolution)) => {
            apply_request_resolution(&resolution, request);
            Ok(Some(resolution))
        }
        Ok(Err(_gone)) => {
            // The oneshot sender was dropped without sending (e.g. the frontend
            // disconnected or the breakpoint-hit emitter failed to deliver).
            // Remove the stale pending entry so the map does not grow unbounded.
            bp.remove_pending(&session_id);
            emit_breakpoint_released(
                event_emitter,
                &session_id,
                BreakpointStage::Request,
                BreakpointReleaseReason::SenderDropped,
            );
            tracing::warn!(
                event = "breakpoint_request_sender_dropped",
                session_id = %session_id,
                "breakpoint_request_sender_dropped"
            );
            Ok(None)
        }
        Err(_elapsed) => {
            // No resolution arrived within the wait window. Remove the stale
            // pending entry and forward without modification so the proxy task
            // does not hang forever holding an upstream connection.
            bp.remove_pending(&session_id);
            emit_breakpoint_released(
                event_emitter,
                &session_id,
                BreakpointStage::Request,
                BreakpointReleaseReason::Timeout,
            );
            tracing::warn!(
                event = "breakpoint_request_wait_timeout",
                session_id = %session_id,
                "breakpoint_request_wait_timeout"
            );
            Ok(None)
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

    let rule_id = match bp.find_matching_rule_id(
        &BreakpointStage::Response,
        request.method.as_str(),
        request.url.as_str(),
    ) {
        Some(id) => id,
        None => return Ok(None),
    };

    let session_id = request.request_id.clone();
    let receiver = bp.register_pending(session_id.clone(), rule_id);

    let hit = build_response_stage_hit(request, status_code, response_headers, response_body);
    tracing::info!(
        event = "breakpoint_response_stage_hit",
        session_id = %session_id,
        method = %request.method,
        url = %request.url,
        status_code = status_code,
        "breakpoint_response_stage_hit"
    );
    emit_breakpoint_event(event_emitter, &hit);

    match tokio::time::timeout(crate::breakpoint_wait_timeout(), receiver).await {
        Ok(Ok(resolution)) => Ok(Some(resolution)),
        Ok(Err(_gone)) => {
            bp.remove_pending(&session_id);
            emit_breakpoint_released(
                event_emitter,
                &session_id,
                BreakpointStage::Response,
                BreakpointReleaseReason::SenderDropped,
            );
            tracing::warn!(
                event = "breakpoint_response_sender_dropped",
                session_id = %session_id,
                "breakpoint_response_sender_dropped"
            );
            Ok(None)
        }
        Err(_elapsed) => {
            bp.remove_pending(&session_id);
            emit_breakpoint_released(
                event_emitter,
                &session_id,
                BreakpointStage::Response,
                BreakpointReleaseReason::Timeout,
            );
            tracing::warn!(
                event = "breakpoint_response_wait_timeout",
                session_id = %session_id,
                "breakpoint_response_wait_timeout"
            );
            Ok(None)
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
        // Drop any stale content-length so session-detail metadata matches the
        // replacement body (L20). The client never hangs — build_hyper_response
        // also strips content-length and lets hyper recompute it — but leaving
        // the old value made the cached detail inconsistent.
        upstream_response.response_headers.remove("content-length");
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
        // A breakpoint mock never reaches the network, so there is no routing
        // decision to report.
        via_upstream_proxy: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build a minimal BreakpointRule.
    fn make_rule(id: &str, enabled: bool) -> BreakpointRule {
        BreakpointRule {
            id: id.to_string(),
            enabled,
            url_pattern: "example.com".to_string(),
            methods: vec![],
            stage: BreakpointStage::Request,
            match_type: None,
        }
    }

    /// Helper to build a minimal ParsedProxyRequest for the request stage.
    fn make_request(session_id: &str) -> ParsedProxyRequest {
        let parsed_url = Url::parse("http://example.com/test").unwrap();
        let request_headers = vec![ProxyHeaderEntry {
            name: "Host".to_string(),
            value: "example.com".to_string(),
            is_pseudo: None,
        }];
        ParsedProxyRequest {
            body: Vec::new(),
            client_address: Some("127.0.0.1:54321".to_string()),
            headers: build_upstream_headers_from_entries(&request_headers)
                .unwrap_or_else(|_| HeaderMap::new()),
            host: "example.com".to_string(),
            method: Method::GET,
            path: build_request_path(&parsed_url),
            protocol: "http".to_string(),
            query_params: build_query_params(&parsed_url),
            raw_request: "GET /test HTTP/1.1\r\nHost: example.com\r\n\r\n".to_string(),
            request_headers,
            request_id: session_id.to_string(),
            url: parsed_url,
            tls_cipher_suite: None,
            tls_protocol: None,
        }
    }

    /// cancel_all should send a Forward resolution to every pending breakpoint.
    #[tokio::test]
    async fn cancel_all_sends_forward_resolution() {
        let manager = BreakpointManager::new();

        let receiver = manager.register_pending("session-1".to_string(), "rule-a".to_string());

        manager.cancel_all();

        let resolution = receiver.await.expect("receiver should not be dropped");
        assert_eq!(resolution.action, BreakpointActionKind::Forward);
        assert_eq!(resolution.session_id, "session-1");
        assert!(resolution.mock.is_none());
        assert!(resolution.modified_request_body_base64.is_none());
        assert!(resolution.modified_request_headers.is_none());
        assert!(resolution.modified_request_query_params.is_none());
        assert!(resolution.modified_response_body_base64.is_none());
        assert!(resolution.modified_response_headers.is_none());
        assert!(resolution.modified_response_status_code.is_none());
    }

    /// cancel_for_rules should only cancel pending breakpoints whose rule_id
    /// appears in the provided list. Other pending entries should remain intact.
    #[tokio::test]
    async fn cancel_for_rules_only_targets_matching_rules() {
        let manager = BreakpointManager::new();

        let receiver_a = manager.register_pending("session-a".to_string(), "rule-a".to_string());
        let receiver_b = manager.register_pending("session-b".to_string(), "rule-b".to_string());

        // Cancel only rule-a.
        manager.cancel_for_rules(&["rule-a".to_string()]);

        // Rule A's receiver should get a Forward resolution.
        let resolution_a = receiver_a.await.expect("receiver A should resolve");
        assert_eq!(resolution_a.action, BreakpointActionKind::Forward);
        assert_eq!(resolution_a.session_id, "session-a");

        // Rule B's entry should still be pending (receiver not resolved).
        // We can verify this by resolving it manually afterward.
        let resolution_b = BreakpointResolution {
            session_id: "session-b".to_string(),
            action: BreakpointActionKind::Drop,
            mock: None,
            modified_request_body_base64: None,
            modified_request_headers: None,
            modified_request_query_params: None,
            modified_response_body_base64: None,
            modified_response_headers: None,
            modified_response_status_code: None,
        };
        manager
            .resolve("session-b", resolution_b)
            .expect("session-b should still be pending");

        let result_b = receiver_b.await.expect("receiver B should resolve");
        assert_eq!(result_b.action, BreakpointActionKind::Drop);
    }

    /// set_rules should cancel pending breakpoints whose rules have been removed
    /// or disabled. Pending breakpoints for still-active rules should remain intact.
    #[tokio::test]
    async fn set_rules_cancels_removed_breakpoints() {
        let manager = BreakpointManager::new();

        // Initially set two active rules: A and B.
        manager.set_rules(vec![make_rule("rule-a", true), make_rule("rule-b", true)]);

        // Register a pending breakpoint for rule A.
        let receiver_a = manager.register_pending("session-a".to_string(), "rule-a".to_string());

        // Now set rules to only include B (remove A).
        manager.set_rules(vec![make_rule("rule-b", true)]);

        // Rule A's pending entry should have received a Forward resolution.
        let resolution_a = receiver_a.await.expect("receiver A should resolve");
        assert_eq!(resolution_a.action, BreakpointActionKind::Forward);
        assert_eq!(resolution_a.session_id, "session-a");
    }

    /// set_rules should cancel pending breakpoints when a rule is disabled
    /// (even if it is still present in the list).
    #[tokio::test]
    async fn set_rules_cancels_disabled_breakpoints() {
        let manager = BreakpointManager::new();

        manager.set_rules(vec![make_rule("rule-a", true)]);

        let receiver_a = manager.register_pending("session-a".to_string(), "rule-a".to_string());

        // Disable rule-a.
        manager.set_rules(vec![make_rule("rule-a", false)]);

        let resolution_a = receiver_a.await.expect("receiver A should resolve");
        assert_eq!(resolution_a.action, BreakpointActionKind::Forward);
    }

    /// resolve should remove the pending entry and send the resolution to the
    /// waiting receiver.
    #[tokio::test]
    async fn resolve_sends_resolution_to_waiting_receiver() {
        let manager = BreakpointManager::new();

        let receiver = manager.register_pending("session-1".to_string(), "rule-a".to_string());

        let resolution = BreakpointResolution {
            session_id: "session-1".to_string(),
            action: BreakpointActionKind::Forward,
            mock: None,
            modified_request_body_base64: None,
            modified_request_headers: None,
            modified_request_query_params: None,
            modified_response_body_base64: None,
            modified_response_headers: None,
            modified_response_status_code: None,
        };

        manager
            .resolve("session-1", resolution)
            .expect("resolve should succeed");

        let result = receiver.await.expect("receiver should resolve");
        assert_eq!(result.action, BreakpointActionKind::Forward);
    }

    /// resolve should return an error for an unknown session ID.
    #[test]
    fn resolve_returns_error_for_unknown_session() {
        let manager = BreakpointManager::new();

        let resolution = BreakpointResolution {
            session_id: "unknown".to_string(),
            action: BreakpointActionKind::Forward,
            mock: None,
            modified_request_body_base64: None,
            modified_request_headers: None,
            modified_request_query_params: None,
            modified_response_body_base64: None,
            modified_response_headers: None,
            modified_response_status_code: None,
        };

        let result = manager.resolve("unknown", resolution);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no pending breakpoint"));
    }

    /// should_break should match enabled rules and skip disabled ones.
    #[test]
    fn should_break_matches_enabled_rules_only() {
        let manager = BreakpointManager::new();

        manager.set_rules(vec![make_rule("rule-a", true), make_rule("rule-b", false)]);

        assert!(manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/test"));
        // rule-b is disabled, so disabling rule-a should make should_break return false.
        manager.set_rules(vec![make_rule("rule-a", false), make_rule("rule-b", true)]);
        // rule-b is now enabled and still matches.
        assert!(manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/test"));
    }

    /// Invalid regex pattern should not panic and should not match any URL.
    #[test]
    fn invalid_regex_does_not_panic_and_does_not_match() {
        let manager = BreakpointManager::new();

        let mut rule = make_rule("bad-regex", true);
        rule.url_pattern = "[invalid(".to_string();
        rule.match_type = Some("regex".to_string());

        manager.set_rules(vec![rule]);

        assert!(!manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/test",));
    }

    /// A valid regex breakpoint rule should match the expected URLs.
    #[test]
    fn valid_regex_breakpoint_matches_correctly() {
        let manager = BreakpointManager::new();

        let mut rule = make_rule("regex-rule", true);
        rule.url_pattern = r"example\.com/\d+".to_string();
        rule.match_type = Some("regex".to_string());

        manager.set_rules(vec![rule]);

        assert!(manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/123",));
        assert!(!manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/abc",));
    }

    /// Updating rules should refresh the pre-compiled regex.
    #[test]
    fn set_rules_refreshes_compiled_regex() {
        let manager = BreakpointManager::new();

        // First set: match digits
        let mut rule_v1 = make_rule("regex-rule", true);
        rule_v1.url_pattern = r"example\.com/\d+".to_string();
        rule_v1.match_type = Some("regex".to_string());
        manager.set_rules(vec![rule_v1]);

        assert!(manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/123",));
        assert!(!manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/abc",));

        // Update: match letters
        let mut rule_v2 = make_rule("regex-rule", true);
        rule_v2.url_pattern = r"example\.com/[a-z]+".to_string();
        rule_v2.match_type = Some("regex".to_string());
        manager.set_rules(vec![rule_v2]);

        assert!(!manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/123",));
        assert!(manager.should_break(&BreakpointStage::Request, "GET", "http://example.com/abc",));
    }

    /// When no resolver ever responds, the request-stage wait must time out
    /// (not hang forever) and remove the stale pending entry. The wait must
    /// also return None so the request forwards unmodified.
    #[tokio::test]
    async fn request_stage_breakpoint_wait_times_out_and_cleans_pending() {
        let _guard =
            crate::override_breakpoint_wait_timeout_for_test(std::time::Duration::from_millis(50));
        let manager = Arc::new(BreakpointManager::new());
        manager.set_rules(vec![make_rule("rule-a", true)]);

        let mut request = make_request("sess-timeout");
        // No emitter and no resolver: the wait must time out within the guard.
        let result = intercept_request_stage(&Some(manager.clone()), &None, &mut request)
            .await
            .expect("intercept should not error on timeout");

        assert!(
            result.is_none(),
            "timeout must forward without modification"
        );
        assert!(
            !manager.pending_contains("sess-timeout"),
            "pending entry must be removed after timeout"
        );
    }

    /// When the oneshot sender is dropped (simulating a frontend disconnect /
    /// emitter failure) after the wait starts, the request-stage path must
    /// detect the dropped sender and clean the pending entry.
    #[tokio::test]
    async fn request_stage_breakpoint_sender_drop_cleans_pending() {
        // Use a long timeout so the dropped-sender path (not the timeout path)
        // is what resolves this test.
        let _guard =
            crate::override_breakpoint_wait_timeout_for_test(std::time::Duration::from_secs(30));
        let manager = Arc::new(BreakpointManager::new());
        manager.set_rules(vec![make_rule("rule-a", true)]);

        // Spawn the interceptor; it will register its own pending entry and
        // wait on the receiver.
        let manager_clone = manager.clone();
        let handle = tokio::spawn(async move {
            let mut request = make_request("sess-drop");
            intercept_request_stage(&Some(manager_clone), &None, &mut request).await
        });

        // Give the interceptor a moment to register its pending entry, then
        // simulate the dropped-sender path (emitter failed / sender dropped)
        // by removing the pending entry without sending a resolution. Removing
        // drops the sender held inside the entry, so the receiver returns Err.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            manager.pending_contains("sess-drop"),
            "pending entry should exist while interceptor is waiting"
        );
        manager.remove_pending("sess-drop");

        let result = handle
            .await
            .expect("task should finish")
            .expect("intercept should not error on dropped sender");
        assert!(
            result.is_none(),
            "dropped sender must forward without modification"
        );
        assert!(
            !manager.pending_contains("sess-drop"),
            "pending entry must be removed after dropped sender"
        );
    }

    /// Review §4.3: when the wait times out, the frontend must learn the hit
    /// was released (it would otherwise keep showing a pending panel for a
    /// request that was already forwarded). The emitter must see
    /// breakpoint-hit followed by breakpoint-released with a timeout reason.
    #[tokio::test]
    async fn emits_breakpoint_released_on_wait_timeout() {
        let _guard =
            crate::override_breakpoint_wait_timeout_for_test(std::time::Duration::from_millis(50));
        let manager = Arc::new(BreakpointManager::new());
        manager.set_rules(vec![make_rule("rule-a", true)]);

        let events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let emitter: BreakpointEventEmitter = Arc::new(move |event, payload| {
            events_clone
                .lock()
                .expect("events mutex poisoned")
                .push((event.to_string(), payload));
        });

        let mut request = make_request("sess-released");
        let result = intercept_request_stage(&Some(manager.clone()), &Some(emitter), &mut request)
            .await
            .expect("intercept should not error on timeout");
        assert!(
            result.is_none(),
            "timeout must forward without modification"
        );

        let events = events.lock().expect("events mutex poisoned");
        assert_eq!(events.len(), 2, "expected hit then released events");
        assert_eq!(events[0].0, "breakpoint-hit");
        assert_eq!(events[1].0, "breakpoint-released");
        assert_eq!(events[1].1["sessionId"], "sess-released");
        assert_eq!(events[1].1["stage"], "request");
        assert_eq!(events[1].1["reason"], "timeout");
    }

    /// The released payload must serialize reasons as camelCase wire values.
    #[test]
    fn breakpoint_release_reason_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(BreakpointReleaseReason::Timeout).unwrap(),
            serde_json::json!("timeout")
        );
        assert_eq!(
            serde_json::to_value(BreakpointReleaseReason::SenderDropped).unwrap(),
            serde_json::json!("senderDropped")
        );
    }

    // -----------------------------------------------------------------------
    // M8: editing the Host header in a breakpoint must update request.host/url
    // -----------------------------------------------------------------------

    fn make_resolution_with_host(host: Option<&str>) -> BreakpointResolution {
        let modified_request_headers = host.map(|h| {
            vec![ProxyHeaderEntry {
                name: "Host".to_string(),
                value: h.to_string(),
                is_pseudo: None,
            }]
        });
        BreakpointResolution {
            session_id: "sess-m8".to_string(),
            action: BreakpointActionKind::Forward,
            mock: None,
            modified_request_headers,
            modified_request_query_params: None,
            modified_request_body_base64: None,
            modified_response_status_code: None,
            modified_response_headers: None,
            modified_response_body_base64: None,
        }
    }

    #[test]
    fn m8_host_header_edit_updates_request_host_and_url() {
        let mut request = make_request("sess-m8-host");
        let original_url = request.url.clone();
        assert_eq!(request.host, "example.com");

        let resolution = make_resolution_with_host(Some("api.retargeted.test"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(
            request.host, "api.retargeted.test",
            "request.host must reflect the edited Host header"
        );
        assert_eq!(
            request.url.host_str(),
            Some("api.retargeted.test"),
            "request.url host must reflect the edited Host header"
        );
        assert!(
            request.url.port().is_none(),
            "no port in header → URL port cleared"
        );
        assert_ne!(
            request.url, original_url,
            "URL must change when host changes"
        );
    }

    #[test]
    fn m8_host_header_edit_with_port_updates_host_and_port() {
        let mut request = make_request("sess-m8-port");
        let resolution = make_resolution_with_host(Some("api.retargeted.test:9090"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(request.host, "api.retargeted.test");
        assert_eq!(
            request.url.port(),
            Some(9090),
            "port from Host header must propagate to request.url"
        );
    }

    #[test]
    fn m8_host_header_edit_keeps_path_and_query() {
        let mut request = make_request("sess-m8-path");
        let original_path = request.url.path().to_string();
        let resolution = make_resolution_with_host(Some("api.retargeted.test"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(
            request.url.path(),
            original_path,
            "path must be preserved when only the host changes"
        );
    }

    #[test]
    fn m8_bracketed_ipv6_with_port_updates_host_and_port() {
        // `[::1]:8080` must split into host `[::1]` and port `8080`, not be
        // treated as the whole string being the host.
        let mut request = make_request("sess-m8-ipv6-port");
        let resolution = make_resolution_with_host(Some("[::1]:8080"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(
            request.host, "[::1]",
            "bracketed IPv6 host must be extracted without the port"
        );
        assert_eq!(
            request.url.host_str(),
            Some("[::1]"),
            "URL host must be the bracketed IPv6 literal"
        );
        assert_eq!(
            request.url.port(),
            Some(8080),
            "port from `[::1]:8080` must propagate to request.url"
        );
    }

    #[test]
    fn m8_bracketed_ipv6_without_port_updates_host_only() {
        let mut request = make_request("sess-m8-ipv6-noport");
        let resolution = make_resolution_with_host(Some("[::1]"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(request.host, "[::1]");
        assert_eq!(request.url.host_str(), Some("[::1]"));
    }

    #[test]
    fn m8_invalid_host_is_rejected_and_leaves_request_untouched() {
        // An unparseable host (e.g. contains spaces / illegal chars) must NOT
        // mutate request.host while leaving request.url stale. Both stay at
        // their original values.
        let mut request = make_request("sess-m8-invalid");
        let original_host = request.host.clone();
        let original_url = request.url.clone();

        let resolution = make_resolution_with_host(Some("not a valid host"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(
            request.host, original_host,
            "invalid host must not pollute request.host"
        );
        assert_eq!(
            request.url, original_url,
            "invalid host must not mutate request.url"
        );
    }

    #[test]
    fn m8_invalid_port_rejects_the_whole_edit() {
        // `host:notaport` — the `:notaport` is not a valid port, so the
        // splitter leaves the whole `host:notaport` as the host candidate, which
        // Url::set_host then rejects (a host cannot contain `:` for non-IPv6).
        // The whole edit is rejected: neither host nor port changes.
        let mut request = make_request("sess-m8-badport");
        let original_host = request.host.clone();
        let original_url = request.url.clone();

        let resolution = make_resolution_with_host(Some("api.retargeted.test:notaport"));
        apply_request_resolution(&resolution, &mut request);

        assert_eq!(
            request.host, original_host,
            "invalid port must not pollute request.host"
        );
        assert_eq!(
            request.url, original_url,
            "invalid port must not mutate request.url"
        );
    }

    #[test]
    fn m8_unclosed_bracket_is_rejected() {
        let mut request = make_request("sess-m8-unclosed");
        let original_host = request.host.clone();
        let resolution = make_resolution_with_host(Some("[::1"));
        apply_request_resolution(&resolution, &mut request);
        assert_eq!(
            request.host, original_host,
            "unclosed bracket must be rejected"
        );
    }
}
