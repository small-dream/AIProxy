use super::*;

fn script_headers_from_entries(entries: &[ProxyHeaderEntry]) -> Vec<ScriptHeader> {
    entries
        .iter()
        .map(|entry| ScriptHeader {
            name: entry.name.clone(),
            value: entry.value.clone(),
        })
        .collect()
}

fn script_headers_from_map(headers: &HeaderMap) -> Vec<ScriptHeader> {
    build_header_entries_from_map(headers)
        .into_iter()
        .map(|entry| ScriptHeader {
            name: entry.name,
            value: entry.value,
        })
        .collect()
}

fn body_text_and_base64(
    body: &[u8],
    content_type: Option<&HeaderValue>,
    content_encoding: Option<&HeaderValue>,
) -> (Option<String>, Option<String>, Option<String>) {
    match build_body_reference(body, content_type, content_encoding, body.len(), false) {
        Some(reference) => (
            reference.inline_text(),
            reference.base64_text(),
            reference.mime_type.clone(),
        ),
        None => (None, None, None),
    }
}

fn build_script_request(
    workspace_id: &str,
    stage: ScriptTraceStage,
    request: &ParsedProxyRequest,
) -> (ScriptSessionInfo, ScriptRequest) {
    let (body_text, body_base64, mime_type) = body_text_and_base64(
        &request.body,
        request.headers.get(CONTENT_TYPE),
        request.headers.get(CONTENT_ENCODING),
    );

    (
        ScriptSessionInfo {
            id: request.request_id.clone(),
            host: request.host.clone(),
            method: request.method.to_string(),
            path: request.path.clone(),
            stage,
            url: request.url.to_string(),
            workspace_id: workspace_id.to_string(),
        },
        ScriptRequest {
            body_base64,
            body_text,
            headers: script_headers_from_entries(&request.request_headers),
            method: request.method.to_string(),
            mime_type,
            url: request.url.to_string(),
        },
    )
}

fn build_script_response(response: &UpstreamResponse) -> ScriptResponse {
    let (body_text, body_base64, mime_type) = body_text_and_base64(
        &response.response_body,
        response.response_headers.get(CONTENT_TYPE),
        response.response_headers.get(CONTENT_ENCODING),
    );

    ScriptResponse {
        body_base64,
        body_text,
        headers: script_headers_from_map(&response.response_headers),
        mime_type,
        status: response.status_code.as_u16(),
    }
}

fn bytes_from_script_body(
    body_text: Option<String>,
    body_base64: Option<String>,
) -> Result<Vec<u8>, String> {
    if let Some(text) = body_text {
        return Ok(text.into_bytes());
    }

    if let Some(base64_text) = body_base64 {
        return BASE64_STANDARD
            .decode(base64_text)
            .map_err(|error| format!("decode script body base64: {error}"));
    }

    Ok(Vec::new())
}

fn header_map_from_script_headers(headers: &[ScriptHeader]) -> HeaderMap {
    let mut header_map = HeaderMap::new();
    for header in headers {
        if let Ok(name) = HeaderName::from_bytes(header.name.as_bytes()) {
            if let Ok(value) = HeaderValue::from_str(&header.value) {
                header_map.append(name, value);
            }
        }
    }
    header_map
}

fn apply_script_request_to_runtime(
    request: &mut ParsedProxyRequest,
    script_request: ScriptRequest,
) -> Result<(), String> {
    request.method = Method::from_bytes(script_request.method.as_bytes()).map_err(|error| {
        format!(
            "invalid script request method '{}': {error}",
            script_request.method
        )
    })?;
    request.url = Url::parse(&script_request.url).map_err(|error| {
        format!(
            "invalid script request url '{}': {error}",
            script_request.url
        )
    })?;
    request.request_headers = script_request
        .headers
        .into_iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name,
            value: header.value,
            is_pseudo: None,
        })
        .collect();
    request.body = bytes_from_script_body(script_request.body_text, script_request.body_base64)?;
    // The script received a DECODED body (see `build_body_reference` /
    // `decode_body_bytes`), and `bytes_from_script_body` returns those decoded
    // plain bytes (or script-supplied base64). Either way the bytes written
    // back are no longer the wire-encoded stream, so strip integrity/encoding
    // headers that would otherwise mis-describe the body. Mirrors the rewrite
    // path (`apply_body_field_rewrite` / response body rewrite).
    strip_plain_body_edit_header_entries(&mut request.request_headers);
    rebuild_request_runtime_state(request)
}

fn apply_script_response_to_runtime(
    response: &mut UpstreamResponse,
    script_response: ScriptResponse,
) -> Result<(), String> {
    response.status_code = StatusCode::from_u16(script_response.status).map_err(|error| {
        format!(
            "invalid script response status '{}': {error}",
            script_response.status
        )
    })?;
    response.response_headers = header_map_from_script_headers(&script_response.headers);
    response.replace_response_body(bytes_from_script_body(
        script_response.body_text,
        script_response.body_base64,
    )?);
    // See `apply_script_request_to_runtime`: the body is now plain decoded
    // bytes, so encoding/integrity headers describing the old wire body must be
    // stripped — otherwise a gzip response served as plain bytes corrupts the
    // client. (content-length is intentionally left; `build_hyper_response_*`
    // recomputes it.)
    strip_plain_body_edit_headers(&mut response.response_headers);
    Ok(())
}

fn upstream_response_from_override(
    override_response: ScriptResponseOverride,
) -> Result<UpstreamResponse, String> {
    let response_body =
        bytes_from_script_body(override_response.body_text, override_response.body_base64)?;

    Ok(UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body_size_bytes: response_body.len(),
        response_body,
        response_headers: {
            let mut headers = header_map_from_script_headers(&override_response.headers);
            // A mock body is plain user-supplied bytes; strip any encoding /
            // integrity headers the script may have echoed so the synthesized
            // response is self-consistent.
            strip_plain_body_edit_headers(&mut headers);
            headers
        },
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::from_u16(override_response.status).map_err(|error| {
            format!(
                "invalid mock response status '{}': {error}",
                override_response.status
            )
        })?,
        tls_ms: None,
        waiting_ms: 0,
        // A script-synthesized response never reaches the network, so there is
        // no routing decision to report.
        via_upstream_proxy: None,
    })
}

fn invalid_trace(mut trace: ScriptTrace, message: String) -> ScriptTrace {
    let next_sequence = trace.entries.len() as u32;
    trace.outcome = ScriptRunOutcome::InvalidResult;
    trace.entries.push(ScriptRunEntry {
        kind: ScriptRunEntryKind::Error,
        key: None,
        level: Some(ScriptLogLevel::Error),
        message: Some(message),
        payload_json: None,
        sequence: next_sequence,
    });
    trace
}

/// H6: build a fail-open runtime-error trace when `spawn_blocking`'s join
/// fails (the task was cancelled/dropped, e.g. runtime shutdown). This is a
/// best-effort fallback: the closure itself never panics on the happy or
/// error paths (it always returns a `RuntimeError` trace), so a join failure
/// almost always means the runtime is tearing down. We still surface a trace
/// so the request is not aborted and the user sees why the hook was skipped.
fn runtime_join_failure_trace(
    stage: ScriptTraceStage,
    rule_id: String,
    rule_name: String,
    join_error: tokio::task::JoinError,
) -> aiproxy_rule_engine::ScriptHookResult {
    // H7: cap the message with the rule-engine's char-boundary-safe
    // `trim_to_byte_limit`. The previous `message[..MAX_MSG_BYTES]` indexed a
    // String at a fixed byte offset, which panics if the offset lands inside a
    // multi-byte UTF-8 code point — `join_error`'s Display (the spawn task's
    // panic payload) can contain arbitrary Unicode. Reusing the shared helper
    // also removes the 4 KB vs 8 KB drift the old comment acknowledged.
    let message = format!("script hook dropped by runtime: {join_error}");
    let message =
        aiproxy_rule_engine::trim_to_byte_limit(&message, aiproxy_rule_engine::MAX_LOG_ENTRY_BYTES);
    aiproxy_rule_engine::ScriptHookResult {
        request: None,
        response: None,
        response_override: None,
        trace: ScriptTrace {
            duration_ms: 0,
            entries: vec![ScriptRunEntry {
                kind: ScriptRunEntryKind::Error,
                key: None,
                level: Some(ScriptLogLevel::Error),
                message: Some(message),
                payload_json: None,
                sequence: 0,
            }],
            outcome: ScriptRunOutcome::RuntimeError,
            rule_id,
            rule_name,
            stage,
        },
    }
}

pub(crate) async fn apply_request_script_rules(
    script_manager: &Option<Arc<ScriptManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> RequestScriptOutcome {
    let mut local_response = None;
    let mut traces = Vec::new();

    for rule in active_script_rules_for_stage(script_manager, workspace_id, "request", request) {
        // H6: build the payload (owned, borrowing `request`) BEFORE spawning so
        // the blocking closure only holds owned, `'static + Send` data. The
        // payload mirrors request/response into owned Strings/Vecs.
        let (session, script_request) =
            build_script_request(workspace_id, ScriptTraceStage::Request, request);
        let payload = ScriptHookPayload {
            request: script_request,
            response: None,
            session,
        };
        // Capture the rule identity up front so we can build a fail-open trace
        // if spawn_blocking is cancelled (rule is moved into the closure below).
        let rule_id = rule.rule.id.clone();
        let rule_name = rule.rule.name.clone();
        // Offload the synchronous QuickJS execution (SCRIPT_GATE Condvar wait +
        // std::thread::spawn + recv_timeout) to the blocking pool so the Tokio
        // worker stays free to poll other tasks. rule + payload are both owned
        // and 'static + Send (verified: CompiledScriptRule, ScriptHookPayload
        // derive Clone with no borrows).
        let result = tokio::task::spawn_blocking(move || execute_request_hook(&rule, payload))
            .await
            .unwrap_or_else(|join_error| {
                // spawn_blocking join failures are rare (the runtime shutting
                // down and dropping the task); fail open with a runtime-error
                // trace so the request is not aborted.
                runtime_join_failure_trace(
                    ScriptTraceStage::Request,
                    rule_id,
                    rule_name,
                    join_error,
                )
            });

        let mut trace = result.trace;

        if let Some(response_override) = result.response_override {
            match upstream_response_from_override(response_override) {
                Ok(response) => {
                    local_response = Some(response);
                    traces.push(trace);
                    break;
                }
                Err(error) => {
                    traces.push(invalid_trace(trace, error));
                    continue;
                }
            }
        }

        if let Some(script_request) = result.request {
            if let Err(error) = apply_script_request_to_runtime(request, script_request) {
                trace = invalid_trace(trace, error);
            }
        }

        traces.push(trace);
    }

    RequestScriptOutcome {
        local_response,
        traces,
    }
}

pub(crate) async fn apply_response_script_rules(
    script_manager: &Option<Arc<ScriptManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
) -> Vec<ScriptTrace> {
    let mut traces = Vec::new();

    for rule in active_script_rules_for_stage(script_manager, workspace_id, "response", request) {
        // H6: build the payload (owned, borrowing request/response) before
        // spawning, then offload the synchronous QuickJS run to the blocking
        // pool. See apply_request_script_rules for the rationale.
        let (session, script_request) =
            build_script_request(workspace_id, ScriptTraceStage::Response, request);
        let payload = ScriptHookPayload {
            request: script_request,
            response: Some(build_script_response(response)),
            session,
        };
        let rule_id = rule.rule.id.clone();
        let rule_name = rule.rule.name.clone();
        let result = tokio::task::spawn_blocking(move || execute_response_hook(&rule, payload))
            .await
            .unwrap_or_else(|join_error| {
                runtime_join_failure_trace(
                    ScriptTraceStage::Response,
                    rule_id,
                    rule_name,
                    join_error,
                )
            });

        let mut trace = result.trace;

        if let Some(script_response) = result.response {
            if let Err(error) = apply_script_response_to_runtime(response, script_response) {
                trace = invalid_trace(trace, error);
            }
        }

        traces.push(trace);
    }

    traces
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ParsedProxyRequest, UpstreamResponse};

    fn make_script_response(body: &str, headers: &[(&str, &str)]) -> ScriptResponse {
        ScriptResponse {
            body_base64: None,
            body_text: Some(body.to_string()),
            headers: headers
                .iter()
                .map(|(name, value)| ScriptHeader {
                    name: name.to_string(),
                    value: value.to_string(),
                })
                .collect(),
            mime_type: None,
            status: 200,
        }
    }

    // H1: editing a (previously compressed) response body via a script must strip
    // content-encoding / integrity headers — the bytes written back are the
    // DECODED plain bytes the script saw, not the original wire stream.
    #[test]
    fn script_response_edit_strips_content_encoding_headers() {
        let mut response = UpstreamResponse {
            body_truncated: false,
            connect_ms: 0,
            dns_ms: 0,
            request_send_ms: 0,
            response_body: b"\x1f\x8bcompressed".to_vec(),
            response_body_size_bytes: 12,
            response_headers: HeaderMap::new(),
            response_read_ms: 0,
            spooled_response_path: None,
            status_code: StatusCode::OK,
            tls_ms: None,
            waiting_ms: 0,
            via_upstream_proxy: None,
        };

        // Script returns the (decoded) plain body and echoes the original
        // headers, including content-encoding: gzip.
        let script_response = make_script_response(
            "{\"ok\":true}",
            &[
                ("content-type", "application/json"),
                ("content-encoding", "gzip"),
                ("etag", "\"abc\""),
            ],
        );

        apply_script_response_to_runtime(&mut response, script_response).unwrap();

        assert!(response.response_headers.get("content-encoding").is_none());
        assert!(response.response_headers.get("etag").is_none());
        // content-type is unrelated to encoding and must survive.
        assert_eq!(
            response.response_headers.get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(response.response_body, br#"{"ok":true}"#);
    }

    // H1 (mock/respond path): a synthesized mock body is plain bytes, so any
    // echoed encoding/integrity headers must be stripped too.
    #[test]
    fn script_response_override_strips_content_encoding_headers() {
        let override_response = ScriptResponseOverride {
            body_base64: None,
            body_text: Some("{\"mocked\":true}".to_string()),
            headers: vec![
                ScriptHeader {
                    name: "content-type".to_string(),
                    value: "application/json".to_string(),
                },
                ScriptHeader {
                    name: "content-encoding".to_string(),
                    value: "gzip".to_string(),
                },
                ScriptHeader {
                    name: "content-md5".to_string(),
                    value: "deadbeef".to_string(),
                },
            ],
            mime_type: None,
            status: 201,
        };

        let response = upstream_response_from_override(override_response).unwrap();

        assert!(response.response_headers.get("content-encoding").is_none());
        assert!(response.response_headers.get("content-md5").is_none());
        assert_eq!(response.status_code, StatusCode::CREATED);
    }

    // H1 (request side): editing the request body via a script must strip the
    // same headers before the request is forwarded upstream.
    #[test]
    fn script_request_edit_strips_content_encoding_headers() {
        let mut request = ParsedProxyRequest {
            body: b"\x1f\x8bcompressed".to_vec(),
            client_address: None,
            headers: HeaderMap::new(),
            host: "example.com".to_string(),
            method: Method::POST,
            path: "/".to_string(),
            protocol: "HTTP/1.1".to_string(),
            query_params: Vec::new(),
            raw_request: String::new(),
            request_headers: vec![ProxyHeaderEntry {
                name: "content-encoding".to_string(),
                value: "gzip".to_string(),
                is_pseudo: None,
            }],
            request_id: "req-1".to_string(),
            url: Url::parse("https://example.com/").unwrap(),
            tls_cipher_suite: None,
            tls_protocol: None,
        };

        let script_request = ScriptRequest {
            body_base64: None,
            body_text: Some("{\"ok\":true}".to_string()),
            headers: vec![
                ScriptHeader {
                    name: "content-type".to_string(),
                    value: "application/json".to_string(),
                },
                ScriptHeader {
                    name: "content-encoding".to_string(),
                    value: "gzip".to_string(),
                },
            ],
            method: "POST".to_string(),
            mime_type: None,
            url: "https://example.com/".to_string(),
        };

        apply_script_request_to_runtime(&mut request, script_request).unwrap();

        assert!(
            request
                .request_headers
                .iter()
                .all(|h| !h.name.eq_ignore_ascii_case("content-encoding")),
            "content-encoding should be stripped, got: {:?}",
            request.request_headers
        );
        assert_eq!(request.body, br#"{"ok":true}"#);
    }
}
