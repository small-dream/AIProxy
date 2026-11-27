//! Inspector "Decoded" view: run a script rule's read-only `decodeRequest` /
//! `decodeResponse` hook against a captured session on demand. Nothing here
//! touches live traffic; the proxy never runs decode hooks.

use super::common::*;
use super::sessions::session_not_found_error;

use aiproxy_proxy_core::{script_decoders_for, ProxyBodyReference};
use aiproxy_rule_engine::{
    execute_decode_hook, CompiledScriptRule, ScriptDecodedBody, ScriptHeader, ScriptHookPayload,
    ScriptRequest, ScriptResponse, ScriptRunEntry, ScriptRunOutcome, ScriptSessionInfo,
    ScriptTraceStage,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindScriptDecodersInput {
    pub method: String,
    pub url: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDecoderRef {
    pub rule_id: String,
    pub rule_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDecodersOutput {
    pub request: Option<ScriptDecoderRef>,
    pub response: Option<ScriptDecoderRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeSessionBodyInput {
    pub session_id: String,
    pub stage: ScriptTraceStage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDecodeOutput {
    pub rule_id: String,
    pub rule_name: String,
    pub stage: ScriptTraceStage,
    pub outcome: ScriptRunOutcome,
    pub duration_ms: u128,
    pub entries: Vec<ScriptRunEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoded: Option<ScriptDecodedBody>,
}

fn active_workspace_id(state: &AppState) -> String {
    state
        .read_status()
        .active_workspace_id
        .unwrap_or_else(|| "default".to_string())
}

/// Which decode rule (if any) applies to a message, so the inspector can show
/// the Decoded tab only where it has something to run. Matching only; no
/// script executes here.
#[tauri::command]
pub fn find_script_decoders(
    input: FindScriptDecodersInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ScriptDecodersOutput, String> {
    let workspace_id = active_workspace_id(&state);
    let manager = state.read_script_manager();
    let first_decoder = |stage| {
        script_decoders_for(&manager, &workspace_id, stage, &input.method, &input.url)
            .into_iter()
            .next()
            .map(|rule| ScriptDecoderRef {
                rule_id: rule.rule.id,
                rule_name: rule.rule.name,
            })
    };

    Ok(ScriptDecodersOutput {
        request: first_decoder(ScriptTraceStage::Request),
        response: first_decoder(ScriptTraceStage::Response),
    })
}

/// Decode a captured request or response body with the matching script rule.
/// Returns `None` when no enabled rule has a decode hook for this message.
#[tauri::command]
pub async fn decode_session_body(
    input: DecodeSessionBodyInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<ScriptDecodeOutput>, String> {
    let state = Arc::clone(state.inner());
    // Decode hooks may run for seconds (pure-JS decryption of large bodies);
    // keep them off the IPC worker.
    run_blocking_command("decode_session_body", move || {
        let Some(detail) = state.read_session_detail(&input.session_id)? else {
            return Err(session_not_found_error(&input.session_id));
        };
        let workspace_id = active_workspace_id(&state);
        let rules = script_decoders_for(
            &state.read_script_manager(),
            &workspace_id,
            input.stage,
            &detail.summary.method,
            &detail.summary.url,
        );
        let payload = build_decode_payload(&detail, &workspace_id, input.stage);
        let output = decode_with_rules(rules, input.stage, payload);

        tracing::debug!(
            component = "desktop.script_decode",
            event = "decode_session_body",
            session_id = %input.session_id,
            stage = ?input.stage,
            rule_id = output.as_ref().map_or("", |o| o.rule_id.as_str()),
            outcome = ?output.as_ref().map(|o| &o.outcome),
            decoded_bytes = output
                .as_ref()
                .and_then(|o| o.decoded.as_ref())
                .map_or(0, |d| d.size_bytes),
            "decode_session_body"
        );
        Ok(output)
    })
    .await
}

/// Run the decoders in priority order and return the first decoded body; if
/// none produces one, return the first rule's result so the user sees why.
fn decode_with_rules(
    rules: Vec<CompiledScriptRule>,
    stage: ScriptTraceStage,
    payload: ScriptHookPayload,
) -> Option<ScriptDecodeOutput> {
    let mut first_result = None;
    for rule in rules {
        let result = execute_decode_hook(&rule, stage, payload.clone());
        let output = ScriptDecodeOutput {
            rule_id: result.trace.rule_id,
            rule_name: result.trace.rule_name,
            stage,
            outcome: result.trace.outcome,
            duration_ms: result.trace.duration_ms,
            entries: result.trace.entries,
            decoded: result.decoded,
        };
        if output.decoded.is_some() {
            return Some(output);
        }
        first_result.get_or_insert(output);
    }
    first_result
}

fn script_headers(entries: &[ProxyHeaderEntry]) -> Vec<ScriptHeader> {
    entries
        .iter()
        // HTTP/2 pseudo headers (:method, :path, ...) are not part of the
        // header map scripts see on live traffic.
        .filter(|entry| entry.is_pseudo != Some(true) && !entry.name.starts_with(':'))
        .map(|entry| ScriptHeader {
            name: entry.name.clone(),
            value: entry.value.clone(),
        })
        .collect()
}

/// `(body_text, body_base64, mime_type)` for a captured (already
/// content-decoded) body. Unlike live hooks, only one representation is sent
/// when it is lossless: bodies reach 20 MB and a second copy would eat the
/// decode hook's heap. The bridge derives the other on demand
/// (`getBase64()` from text, `getText()` from base64).
fn script_body(
    body: Option<&ProxyBodyReference>,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(body) = body else {
        return (None, None, None);
    };
    let mime_type = body.mime_type.clone();
    if !body.can_render_as_text() {
        return (None, body.base64_text(), mime_type);
    }
    match body.read_bytes() {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (Some(text), None, mime_type),
            // Not valid UTF-8: keep the exact bytes next to the lossy text.
            Err(error) => {
                let bytes = error.into_bytes();
                (
                    Some(String::from_utf8_lossy(&bytes).into_owned()),
                    Some(BASE64_STANDARD.encode(&bytes)),
                    mime_type,
                )
            }
        },
        Err(error) => {
            tracing::warn!(
                component = "desktop.script_decode",
                event = "read_body_failed",
                error = %error,
                "read_body_failed"
            );
            (None, None, mime_type)
        }
    }
}

fn build_decode_payload(
    detail: &ProxySessionDetail,
    workspace_id: &str,
    stage: ScriptTraceStage,
) -> ScriptHookPayload {
    let summary = &detail.summary;
    let (request_text, request_base64, request_mime) = script_body(detail.request_body.as_ref());
    let response = match stage {
        ScriptTraceStage::Request => None,
        ScriptTraceStage::Response => {
            let (body_text, body_base64, mime_type) = script_body(detail.response_body.as_ref());
            Some(ScriptResponse {
                body_base64,
                body_text,
                headers: script_headers(&detail.response_headers),
                mime_type,
                status: summary.status_code,
            })
        }
    };

    ScriptHookPayload {
        request: ScriptRequest {
            body_base64: request_base64,
            body_text: request_text,
            headers: script_headers(&detail.request_headers),
            method: summary.method.clone(),
            mime_type: request_mime,
            url: summary.url.clone(),
        },
        response,
        session: ScriptSessionInfo {
            id: summary.id.clone(),
            host: summary.host.clone(),
            method: summary.method.clone(),
            path: summary.path.clone(),
            stage,
            url: summary.url.clone(),
            workspace_id: workspace_id.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_rule_engine::{
        compile_script_rule, ScriptDecodedKind, ScriptEntrypoints, ScriptRuleMatch,
    };

    fn header(name: &str, value: &str, is_pseudo: Option<bool>) -> ProxyHeaderEntry {
        ProxyHeaderEntry {
            name: name.to_string(),
            value: value.to_string(),
            is_pseudo,
        }
    }

    fn text_body(text: &str, mime: &str) -> ProxyBodyReference {
        ProxyBodyReference::from_decoded_bytes(
            text.as_bytes().to_vec(),
            Some(mime.to_string()),
            text.len(),
            false,
            true,
        )
    }

    fn detail() -> ProxySessionDetail {
        ProxySessionDetail {
            client_address: None,
            cookies: Vec::new(),
            failure: None,
            id: "session-1".to_string(),
            query_params: Vec::new(),
            raw_request_head: None,
            raw_response_head: None,
            request_body: Some(text_body("3ae52ef7", "text/plain")),
            request_headers: vec![
                header(":method", "POST", Some(true)),
                header("content-type", "text/plain", None),
            ],
            response_body: Some(text_body(r#"{"result":"cafe"}"#, "application/json")),
            response_headers: vec![header("content-type", "application/json", Some(false))],
            map_traces: Vec::new(),
            rewrite_traces: Vec::new(),
            server_ip: None,
            tls_cipher_suite: None,
            tls_protocol: None,
            summary: ProxySessionSummary {
                id: "session-1".to_string(),
                method: "POST".to_string(),
                host: "api.example.com".to_string(),
                path: "/app/data".to_string(),
                protocol: "HTTP/2".to_string(),
                scheme: "https".to_string(),
                http_version: "2".to_string(),
                transport_protocol: "tcp".to_string(),
                application_protocol: "http".to_string(),
                started_at: "2026-11-26T00:00:00Z".to_string(),
                finished_at: "2026-11-26T00:00:01Z".to_string(),
                duration_ms: 1000,
                size_bytes: 17,
                status_code: 200,
                url: "https://api.example.com/app/data".to_string(),
                response_mime_type: Some("application/json".to_string()),
                failure: None,
            },
            script_traces: Vec::new(),
            throttle_traces: Vec::new(),
            timing: None,
            timing_source: None,
            trailers: None,
            h2_stream_id: None,
            via_upstream_proxy: None,
        }
    }

    fn decoder(id: &str, source: &str) -> CompiledScriptRule {
        compile_script_rule(ScriptRule {
            id: id.to_string(),
            workspace_id: "default".to_string(),
            name: format!("{id} name"),
            note: None,
            enabled: true,
            priority: 0,
            r#match: ScriptRuleMatch {
                url_pattern: "api.example.com".to_string(),
                methods: Vec::new(),
                stage: "either".to_string(),
                match_type: None,
            },
            language: ScriptRuleLanguage::JavaScript,
            source_type: ScriptRuleSourceType::Inline,
            source_code: source.to_string(),
            source_path: None,
            entrypoints: ScriptEntrypoints {
                on_request: false,
                on_response: false,
                decode_request: false,
                decode_response: false,
            },
        })
        .expect("decoder compiles")
    }

    #[test]
    fn request_payload_carries_the_captured_request_without_pseudo_headers() {
        let payload = build_decode_payload(&detail(), "ws-1", ScriptTraceStage::Request);

        assert_eq!(payload.request.method, "POST");
        assert_eq!(payload.request.url, "https://api.example.com/app/data");
        assert_eq!(payload.request.body_text.as_deref(), Some("3ae52ef7"));
        assert_eq!(payload.request.headers.len(), 1);
        assert_eq!(payload.request.headers[0].name, "content-type");
        assert!(payload.response.is_none());
        assert_eq!(payload.session.workspace_id, "ws-1");
        assert_eq!(payload.session.stage, ScriptTraceStage::Request);
    }

    #[test]
    fn bodies_are_sent_once_unless_text_would_lose_bytes() {
        let text = text_body("plain", "text/plain");
        assert_eq!(
            script_body(Some(&text)),
            (
                Some("plain".to_string()),
                None,
                Some("text/plain".to_string())
            )
        );

        let binary = ProxyBodyReference::from_decoded_bytes(
            vec![0, 159, 146, 150],
            Some("application/octet-stream".to_string()),
            4,
            false,
            false,
        );
        assert_eq!(
            script_body(Some(&binary)),
            (
                None,
                Some("AJ+Slg==".to_string()),
                Some("application/octet-stream".to_string())
            )
        );

        let invalid_utf8 = ProxyBodyReference::from_decoded_bytes(
            vec![b'a', 0xff],
            Some("text/plain".to_string()),
            2,
            false,
            true,
        );
        assert_eq!(
            script_body(Some(&invalid_utf8)),
            (
                Some("a\u{fffd}".to_string()),
                Some("Yf8=".to_string()),
                Some("text/plain".to_string())
            )
        );
    }

    #[test]
    fn response_payload_carries_status_headers_and_body() {
        let payload = build_decode_payload(&detail(), "ws-1", ScriptTraceStage::Response);

        let response = payload.response.expect("response payload");
        assert_eq!(response.status, 200);
        assert_eq!(response.body_text.as_deref(), Some(r#"{"result":"cafe"}"#));
        assert_eq!(response.mime_type.as_deref(), Some("application/json"));
        assert_eq!(response.headers.len(), 1);
    }

    #[test]
    fn first_rule_that_decodes_wins() {
        let payload = build_decode_payload(&detail(), "default", ScriptTraceStage::Response);
        let output = decode_with_rules(
            vec![
                decoder("silent", "export function decodeResponse() {}"),
                decoder(
                    "json",
                    "export function decodeResponse(ctx) { return { result: ctx.response.getJson().result }; }",
                ),
            ],
            ScriptTraceStage::Response,
            payload,
        )
        .expect("a decoder ran");

        assert_eq!(output.rule_id, "json");
        assert_eq!(output.rule_name, "json name");
        assert_eq!(output.outcome, ScriptRunOutcome::Success);
        let decoded = output.decoded.expect("decoded body");
        assert_eq!(decoded.kind, ScriptDecodedKind::Json);
        assert_eq!(decoded.text, r#"{"result":"cafe"}"#);
    }

    #[test]
    fn reports_the_first_failure_when_nothing_decodes() {
        let payload = build_decode_payload(&detail(), "default", ScriptTraceStage::Response);
        let output = decode_with_rules(
            vec![
                decoder(
                    "broken",
                    "export function decodeResponse() { throw new Error('bad key'); }",
                ),
                decoder("silent", "export function decodeResponse() {}"),
            ],
            ScriptTraceStage::Response,
            payload,
        )
        .expect("a decoder ran");

        assert_eq!(output.rule_id, "broken");
        assert_eq!(output.outcome, ScriptRunOutcome::RuntimeError);
        assert!(output.decoded.is_none());
        assert!(output
            .entries
            .iter()
            .any(|entry| entry.message.as_deref() == Some("bad key")));
    }

    #[test]
    fn no_decoder_means_no_output() {
        let payload = build_decode_payload(&detail(), "default", ScriptTraceStage::Request);
        assert!(decode_with_rules(Vec::new(), ScriptTraceStage::Request, payload).is_none());
    }

    #[test]
    fn decode_output_serializes_for_the_frontend_contract() {
        let payload = build_decode_payload(&detail(), "default", ScriptTraceStage::Response);
        let output = decode_with_rules(
            vec![decoder(
                "text",
                "export function decodeResponse() { return 'hello'; }",
            )],
            ScriptTraceStage::Response,
            payload,
        )
        .expect("a decoder ran");

        let value = serde_json::to_value(&output).expect("serializes");
        assert_eq!(value["ruleId"], "text");
        assert_eq!(value["stage"], "response");
        assert_eq!(value["outcome"], "success");
        assert_eq!(value["decoded"]["kind"], "text");
        assert_eq!(value["decoded"]["text"], "hello");
        assert_eq!(value["decoded"]["sizeBytes"], 5);
        assert_eq!(value["decoded"]["truncated"], false);
    }
}
