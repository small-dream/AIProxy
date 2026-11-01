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

/// The body state a script bridge hands back, reconciled with what the script
/// actually did.
#[derive(Debug)]
struct ScriptBodyUpdate {
    bytes: Vec<u8>,
    /// The bridge echoed the body back untouched: both the lossy `bodyText` and
    /// the byte-exact `bodyBase64` still agree. The caller must then keep the
    /// ORIGINAL wire bytes and the encoding/integrity headers the script echoed.
    ///
    /// This matters whenever the wire body could not be decoded (an unsupported
    /// `content-encoding` such as `zstd`, a >64 MiB expansion, a corrupt
    /// gzip/br stream): the "decoded" mirror is the compressed stream itself, so
    /// writing it back while stripping `content-encoding` served compressed
    /// bytes as plain text (P2-2).
    unchanged: bool,
}

/// The exact body fields the JS bridge handed to the script. Comparing the
/// returned fields against these lets `script_body_update` tell which
/// representation a direct assignment (`ctx.response.bodyBase64 = ...`) changed
/// instead of guessing from the lossy text rendering.
#[derive(Clone, Copy)]
struct ScriptBodyEcho<'a> {
    text: Option<&'a str>,
    base64: Option<&'a str>,
}

fn script_body_update(
    body_text: Option<String>,
    body_base64: Option<String>,
    original: Option<ScriptBodyEcho<'_>>,
) -> Result<ScriptBodyUpdate, String> {
    // When the bridge hands back both fields, `bodyText` is the lossy UTF-8
    // rendering of `bodyBase64`'s bytes. A script that only read the body (or
    // edited headers) leaves them in exactly that state, and the base64 image is
    // the byte-exact body — re-encoding the lossy text would corrupt any
    // non-UTF-8 payload (a GBK `text/html` page, a Latin-1 response), silently,
    // as soon as an unrelated header was changed. A script that assigned
    // `bodyText` directly makes it diverge from that rendering, so the edit
    // still wins.
    //
    // Direct assignment to `bodyBase64` (documented in script-rules.md) is the
    // mirror case: the text stays untouched while the base64 changes, so the
    // lossy comparison alone would keep the OLD text and drop the edit. The
    // caller passes the exact fields the bridge produced (`original`) so a
    // single changed representation can be identified unambiguously.
    match (body_text, body_base64) {
        (Some(text), Some(base64_text)) => match BASE64_STANDARD.decode(&base64_text) {
            Ok(decoded) => match original {
                Some(original) => {
                    let text_changed = original.text != Some(text.as_str());
                    let base64_changed = original.base64 != Some(base64_text.as_str());
                    if !text_changed && !base64_changed {
                        Ok(ScriptBodyUpdate {
                            bytes: decoded,
                            unchanged: true,
                        })
                    } else if base64_changed && !text_changed {
                        // DIRECT bodyBase64 assignment: only the byte-exact
                        // representation changed, so it is the edit.
                        Ok(ScriptBodyUpdate {
                            bytes: decoded,
                            unchanged: false,
                        })
                    } else {
                        // bodyText changed (or both did): the text edit wins.
                        Ok(ScriptBodyUpdate {
                            bytes: text.into_bytes(),
                            unchanged: false,
                        })
                    }
                }
                // No bridge snapshot available (mock/override or a unit test):
                // fall back to comparing the two representations.
                None => {
                    if String::from_utf8_lossy(&decoded).as_ref() == text.as_str() {
                        Ok(ScriptBodyUpdate {
                            bytes: decoded,
                            unchanged: true,
                        })
                    } else {
                        Ok(ScriptBodyUpdate {
                            bytes: text.into_bytes(),
                            unchanged: false,
                        })
                    }
                }
            },
            // The text diverged (script edit) or the base64 is unusable: keep
            // the script's text.
            Err(_) => Ok(ScriptBodyUpdate {
                bytes: text.into_bytes(),
                unchanged: false,
            }),
        },
        (Some(text), None) => Ok(ScriptBodyUpdate {
            bytes: text.into_bytes(),
            unchanged: false,
        }),
        (None, Some(base64_text)) => Ok(ScriptBodyUpdate {
            bytes: BASE64_STANDARD
                .decode(base64_text)
                .map_err(|error| format!("decode script body base64: {error}"))?,
            unchanged: false,
        }),
        (None, None) => Ok(ScriptBodyUpdate {
            bytes: Vec::new(),
            unchanged: false,
        }),
    }
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
    original_body: Option<ScriptBodyEcho<'_>>,
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
    let body_update = script_body_update(
        script_request.body_text,
        script_request.body_base64,
        original_body,
    )?;
    // Only a script EDIT invalidates the wire body and its integrity headers.
    // When the script echoed the body untouched, keep the original bytes and the
    // headers it echoed: they may still describe a compressed stream the bridge
    // could not decode (P2-2).
    if !body_update.unchanged {
        request.body = body_update.bytes;
        // The bytes written back are the decoded/edited plain form, so strip
        // integrity/encoding headers that would otherwise mis-describe them.
        // Mirrors the rewrite path (`apply_body_field_rewrite`).
        strip_plain_body_edit_header_entries(&mut request.request_headers);
    }
    rebuild_request_runtime_state(request)
}

fn apply_script_response_to_runtime(
    response: &mut UpstreamResponse,
    script_response: ScriptResponse,
    original_body: Option<ScriptBodyEcho<'_>>,
) -> Result<(), String> {
    response.status_code = StatusCode::from_u16(script_response.status).map_err(|error| {
        format!(
            "invalid script response status '{}': {error}",
            script_response.status
        )
    })?;
    response.response_headers = header_map_from_script_headers(&script_response.headers);
    let body_update = script_body_update(
        script_response.body_text,
        script_response.body_base64,
        original_body,
    )?;
    // See `apply_script_request_to_runtime`: an untouched body keeps its wire
    // bytes and the encoding headers the script echoed (P2-2); only an edited
    // body is replaced with plain bytes and has those headers stripped.
    if !body_update.unchanged {
        response.replace_response_body(body_update.bytes);
        strip_plain_body_edit_headers(&mut response.response_headers);
    }
    Ok(())
}

fn upstream_response_from_override(
    override_response: ScriptResponseOverride,
) -> Result<UpstreamResponse, String> {
    // A mock/override body is always a script-supplied plain payload, so it is
    // never "unchanged" even when the script reused both echo fields.
    let response_body = script_body_update(
        override_response.body_text,
        override_response.body_base64,
        None,
    )?
    .bytes;

    Ok(UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        connection_reused: None,
        connection_wait_ms: None,
        request_send_ms: None,
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
        // Snapshot the exact body fields the script receives so a direct
        // `bodyBase64` assignment can be distinguished from an untouched echo.
        let body_text_before = script_request.body_text.clone();
        let body_base64_before = script_request.body_base64.clone();
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
            let original_body = ScriptBodyEcho {
                text: body_text_before.as_deref(),
                base64: body_base64_before.as_deref(),
            };
            if let Err(error) =
                apply_script_request_to_runtime(request, script_request, Some(original_body))
            {
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
        let script_response = build_script_response(response);
        // Snapshot the exact body fields the script receives (see the request
        // loop above): a direct bodyBase64 assignment must not be mistaken for
        // an untouched echo.
        let body_text_before = script_response.body_text.clone();
        let body_base64_before = script_response.body_base64.clone();
        let payload = ScriptHookPayload {
            request: script_request,
            response: Some(script_response),
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
            let original_body = ScriptBodyEcho {
                text: body_text_before.as_deref(),
                base64: body_base64_before.as_deref(),
            };
            if let Err(error) =
                apply_script_response_to_runtime(response, script_response, Some(original_body))
            {
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
            connection_reused: None,
            connection_wait_ms: None,
            request_send_ms: None,
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

        apply_script_response_to_runtime(&mut response, script_response, None).unwrap();

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

        apply_script_request_to_runtime(&mut request, script_request, None).unwrap();

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

    // -----------------------------------------------------------------------
    // script_body_update — lossy text vs byte-exact base64
    // -----------------------------------------------------------------------

    /// GBK-encoded `中文` wrapped in a tiny HTML document: not valid UTF-8, so
    /// `inline_text()` renders it with U+FFFD replacement characters.
    fn gbk_html_body() -> Vec<u8> {
        let mut body = b"<title>".to_vec();
        body.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]); // GBK "中文"
        body.extend_from_slice(b"</title>");
        body
    }

    // A script that only touches headers must not rewrite a non-UTF-8 body: the
    // bridge leaves both fields intact, and the base64 image is authoritative.
    #[test]
    fn script_body_keeps_exact_bytes_when_text_is_the_lossy_rendering() {
        let raw = gbk_html_body();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(
            text.contains('\u{FFFD}'),
            "fixture must be lossy under UTF-8, got: {text}"
        );

        let update = script_body_update(Some(text), Some(BASE64_STANDARD.encode(&raw)), None)
            .expect("base64 decodes");

        assert_eq!(update.bytes, raw, "untouched body must stay byte-exact");
        assert!(update.unchanged, "both fields agreeing means untouched");
    }

    // A script that assigns `bodyText` directly (without the helper) produces a
    // value that no longer matches the lossy rendering, so the edit wins.
    #[test]
    fn script_body_text_edit_wins_over_untouched_base64() {
        let raw = b"{\"ok\":true}";
        let update = script_body_update(
            Some("{\"ok\":false}".to_string()),
            Some(BASE64_STANDARD.encode(raw)),
            None,
        )
        .expect("base64 decodes even when the text edit wins");

        assert_eq!(update.bytes, br#"{"ok":false}"#);
        assert!(!update.unchanged, "a diverging text is a script edit");
    }

    #[test]
    fn script_body_uses_whichever_representation_is_present() {
        // Helper-driven edits null the other field (setText → bodyBase64=None).
        assert_eq!(
            script_body_update(Some("edited".to_string()), None, None)
                .unwrap()
                .bytes,
            b"edited"
        );
        // setBase64 → bodyText=None.
        assert_eq!(
            script_body_update(None, Some(BASE64_STANDARD.encode("from-base64")), None)
                .unwrap()
                .bytes,
            b"from-base64"
        );
        // Empty body from either side.
        assert!(script_body_update(None, None, None)
            .unwrap()
            .bytes
            .is_empty());
        assert!(
            script_body_update(Some(String::new()), Some(String::new()), None)
                .unwrap()
                .bytes
                .is_empty()
        );
    }

    // An unusable base64 payload must not turn a text-carrying script into a
    // hard failure: the text path is what the pre-existing implementation used.
    #[test]
    fn script_body_ignores_malformed_base64_when_text_is_present() {
        let update = script_body_update(
            Some("{\"ok\":true}".to_string()),
            Some("not-base64!!".to_string()),
            None,
        )
        .expect("text still applies");

        assert_eq!(update.bytes, br#"{"ok":true}"#);
    }

    #[test]
    fn script_body_errors_when_only_base64_is_present_and_malformed() {
        let error = script_body_update(None, Some("not-base64!!".to_string()), None)
            .expect_err("malformed base64 with no text cannot be decoded");
        assert!(error.contains("base64"), "unexpected error: {error}");
    }

    fn script_header(name: &str, value: &str) -> ScriptHeader {
        ScriptHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    // P2-2: when the bridge cannot decode the wire body (`zstd`, an over-cap
    // expansion, a corrupt stream) the "decoded" mirror is the compressed bytes
    // themselves. A script that only edited a header then used to write those
    // bytes back while stripping `content-encoding`, so clients received
    // compressed data as plain text. The untouched body must keep both.
    #[test]
    fn untouched_compressed_script_response_keeps_wire_bytes_and_encoding() {
        let wire = b"\x28\xb5\x2f\xfdnot-really-zstd\x00\x01".to_vec();
        let text = String::from_utf8_lossy(&wire).to_string();
        assert!(
            text.contains('\u{FFFD}'),
            "fixture must be lossy under UTF-8"
        );

        let mut response = UpstreamResponse {
            body_truncated: false,
            connect_ms: 0,
            connection_reused: None,
            connection_wait_ms: None,
            dns_ms: 0,
            request_send_ms: None,
            response_body: wire.clone(),
            response_body_size_bytes: wire.len(),
            response_headers: HeaderMap::new(),
            response_read_ms: 0,
            spooled_response_path: None,
            status_code: StatusCode::OK,
            tls_ms: None,
            waiting_ms: 0,
            via_upstream_proxy: None,
        };

        let script_response = ScriptResponse {
            body_base64: Some(BASE64_STANDARD.encode(&wire)),
            body_text: Some(text),
            headers: vec![
                script_header("content-type", "application/json"),
                script_header("content-encoding", "zstd"),
                script_header("x-scripted", "yes"),
            ],
            mime_type: None,
            status: 200,
        };

        apply_script_response_to_runtime(&mut response, script_response, None).unwrap();

        assert_eq!(
            response.response_body, wire,
            "the untouched wire body must not be rewritten"
        );
        assert_eq!(
            response.response_headers.get("content-encoding").unwrap(),
            "zstd",
            "an untouched body keeps the encoding that describes it"
        );
        assert_eq!(
            response.response_headers.get("x-scripted").unwrap(),
            "yes",
            "header-only script edits must still apply"
        );
    }

    // Mirror of the response case on the request path: forwarding compressed
    // bytes as a plain body makes the upstream reject or mis-parse the request.
    #[test]
    fn untouched_compressed_script_request_keeps_wire_bytes_and_encoding() {
        let wire = b"\x28\xb5\x2f\xfdnot-really-zstd\x00\x01".to_vec();
        let text = String::from_utf8_lossy(&wire).to_string();

        let mut request = ParsedProxyRequest {
            body: wire.clone(),
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
                value: "zstd".to_string(),
                is_pseudo: None,
            }],
            request_id: "req-1".to_string(),
            url: Url::parse("https://example.com/").unwrap(),
            tls_cipher_suite: None,
            tls_protocol: None,
        };

        let script_request = ScriptRequest {
            body_base64: Some(BASE64_STANDARD.encode(&wire)),
            body_text: Some(text),
            headers: vec![
                script_header("content-type", "application/json"),
                script_header("content-encoding", "zstd"),
            ],
            method: "POST".to_string(),
            mime_type: None,
            url: "https://example.com/".to_string(),
        };

        apply_script_request_to_runtime(&mut request, script_request, None).unwrap();

        assert_eq!(request.body, wire, "the untouched wire body must survive");
        assert!(
            request
                .request_headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("content-encoding")),
            "content-encoding must still describe the wire body, got: {:?}",
            request.request_headers
        );
    }

    // P1-3: `script-rules.md` documents DIRECT assignment to `bodyBase64` (not
    // only `setBase64()`). The bridge then returns the untouched lossy text
    // together with the edited base64; the byte-exact representation is the
    // edit and must win (the previous lossy comparison dropped it silently and
    // re-encoded the old text, corrupting non-UTF-8 bodies).
    #[test]
    fn script_response_direct_base64_assignment_is_applied() {
        let wire = gbk_html_body();
        let original_text = String::from_utf8_lossy(&wire).to_string();
        let original_base64 = BASE64_STANDARD.encode(&wire);
        let replacement = b"{\"ok\":false}".to_vec();

        let mut response = UpstreamResponse {
            body_truncated: false,
            connect_ms: 0,
            connection_reused: None,
            connection_wait_ms: None,
            dns_ms: 0,
            request_send_ms: None,
            response_body: wire.clone(),
            response_body_size_bytes: wire.len(),
            response_headers: HeaderMap::new(),
            response_read_ms: 0,
            spooled_response_path: None,
            status_code: StatusCode::OK,
            tls_ms: None,
            waiting_ms: 0,
            via_upstream_proxy: None,
        };

        let script_response = ScriptResponse {
            // Untouched lossy text + directly assigned base64.
            body_text: Some(original_text.clone()),
            body_base64: Some(BASE64_STANDARD.encode(&replacement)),
            headers: vec![
                script_header("content-type", "application/json"),
                script_header("content-encoding", "gzip"),
            ],
            mime_type: None,
            status: 200,
        };

        apply_script_response_to_runtime(
            &mut response,
            script_response,
            Some(ScriptBodyEcho {
                text: Some(original_text.as_str()),
                base64: Some(original_base64.as_str()),
            }),
        )
        .unwrap();

        assert_eq!(response.response_body, replacement);
        assert!(
            response.response_headers.get("content-encoding").is_none(),
            "a replaced plain body must not keep content-encoding"
        );
    }

    #[test]
    fn script_body_untouched_echo_with_original_is_unchanged() {
        let raw = gbk_html_body();
        let text = String::from_utf8_lossy(&raw).to_string();
        let base64 = BASE64_STANDARD.encode(&raw);

        let update = script_body_update(
            Some(text.clone()),
            Some(base64.clone()),
            Some(ScriptBodyEcho {
                text: Some(text.as_str()),
                base64: Some(base64.as_str()),
            }),
        )
        .unwrap();

        assert!(update.unchanged, "identical echo fields mean untouched");
        assert_eq!(update.bytes, raw);
    }

    #[test]
    fn script_body_direct_base64_edit_wins_over_untouched_text() {
        let raw = gbk_html_body();
        let text = String::from_utf8_lossy(&raw).to_string();
        let original_base64 = BASE64_STANDARD.encode(&raw);
        let replacement = BASE64_STANDARD.encode("{\"ok\":false}");

        let update = script_body_update(
            Some(text.clone()),
            Some(replacement),
            Some(ScriptBodyEcho {
                text: Some(text.as_str()),
                base64: Some(original_base64.as_str()),
            }),
        )
        .unwrap();

        assert_eq!(update.bytes, br#"{"ok":false}"#);
        assert!(!update.unchanged, "a changed base64 is a script edit");
    }
}
