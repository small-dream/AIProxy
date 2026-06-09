use super::common::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionDetailInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionDetailContentInput {
    pub session_id: String,
    pub include_raw_request: Option<bool>,
    pub include_raw_response: Option<bool>,
    pub include_request_body_text: Option<bool>,
    pub include_response_body_text: Option<bool>,
    pub include_request_body_base64: Option<bool>,
    pub include_response_body_base64: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBodyPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    base64_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inline_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    size_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_address: Option<String>,
    cookies: Vec<ProxyHeaderEntry>,
    id: String,
    query_params: Vec<ProxyHeaderEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_body: Option<SessionBodyPayload>,
    request_headers: Vec<ProxyHeaderEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_body: Option<SessionBodyPayload>,
    response_headers: Vec<ProxyHeaderEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    map_traces: Vec<aiproxy_proxy_core::MapTrace>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rewrite_traces: Vec<aiproxy_proxy_core::RewriteTrace>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    throttle_traces: Vec<aiproxy_proxy_core::ThrottleTrace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tls_cipher_suite: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tls_protocol: Option<String>,
    summary: ProxySessionSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<ProxyTimingBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trailers: Option<Vec<ProxyHeaderEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    h2_stream_id: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBodyContentPatchPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    base64_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inline_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_deferred: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailContentPatchPayload {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response_deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_body: Option<SessionBodyContentPatchPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_body: Option<SessionBodyContentPatchPayload>,
}

const SESSION_NOT_FOUND_CODE: &str = "SESSION_NOT_FOUND";

use super::common::app_error_with_details;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsExceptInput {
    pub keep_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFocusedHostsInput {
    pub hosts: Vec<String>,
}

#[tauri::command]
pub fn delete_sessions_except(input: DeleteSessionsExceptInput, state: State<'_, Arc<AppState>>) {
    state.delete_sessions_except(&input.keep_session_id);
}

#[tauri::command]
pub fn set_focused_hosts(input: SetFocusedHostsInput, state: State<'_, Arc<AppState>>) {
    state.set_focused_hosts(input.hosts);
}

#[tauri::command]
pub fn get_bootstrap_status(state: State<'_, Arc<AppState>>) -> BootstrapStatus {
    state.read_status()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<ProxySessionSummary>, String> {
    Ok(state.read_sessions())
}

#[tauri::command]
pub fn get_session_detail(
    input: GetSessionDetailInput,
    state: State<'_, Arc<AppState>>,
) -> Result<SessionDetailPayload, String> {
    let detail = match state.read_session_detail(&input.session_id) {
        Some(detail) => detail,
        None => {
            log_session_not_found(
                "get_session_detail",
                &input.session_id,
                state.inner().as_ref(),
            );
            return Err(session_not_found_error(&input.session_id));
        }
    };
    let payload = build_session_detail_payload(&detail);

    log_session_detail_serialization_stats(&detail, &payload);

    Ok(payload)
}

#[tauri::command]
pub fn get_session_detail_content(
    input: GetSessionDetailContentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<SessionDetailContentPatchPayload, String> {
    let detail = match state.read_session_detail(&input.session_id) {
        Some(detail) => detail,
        None => {
            log_session_not_found(
                "get_session_detail_content",
                &input.session_id,
                state.inner().as_ref(),
            );
            return Err(session_not_found_error(&input.session_id));
        }
    };
    let payload = build_session_detail_content_patch(&detail, &input);

    log_session_detail_content_stats(&detail, &payload, &input);

    Ok(payload)
}

fn session_not_found_error(session_id: &str) -> String {
    app_error_with_details(
        SESSION_NOT_FOUND_CODE,
        &format!("Captured session {session_id} was not found."),
        serde_json::json!({ "sessionId": session_id }),
    )
}

fn log_session_not_found(command_name: &str, session_id: &str, state: &AppState) {
    let sessions = state.read_sessions();
    let summary = sessions.iter().find(|session| session.id == session_id);

    tracing::warn!(
        component = "desktop.sessions",
        event = "session_detail_not_found",
        command_name = %command_name,
        session_id = %session_id,
        session_count = sessions.len(),
        summary_in_memory = summary.is_some(),
        method = summary.as_ref().map_or("", |s| s.method.as_str()),
        host = summary.as_ref().map_or("", |s| s.host.as_str()),
        path = summary.as_ref().map_or("", |s| s.path.as_str()),
        url = summary.as_ref().map_or("", |s| s.url.as_str()),
        status_code = summary.as_ref().map_or(0, |s| s.status_code),
        started_at = summary.as_ref().map_or("", |s| s.started_at.as_str()),
        finished_at = summary.as_ref().map_or("", |s| s.finished_at.as_str()),
        "session_detail_not_found"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_not_found_error_uses_structured_app_error_payload() {
        let error = session_not_found_error("session-1");
        let payload: serde_json::Value = serde_json::from_str(&error).expect("valid json");

        assert_eq!(payload["code"], "SESSION_NOT_FOUND");
        assert_eq!(payload["details"]["sessionId"], "session-1");
    }
}

fn log_session_detail_serialization_stats(
    detail: &ProxySessionDetail,
    payload: &SessionDetailPayload,
) {
    if !session_stats::is_enabled() {
        return;
    }

    let serialization_started_at = Instant::now();
    let result = serde_json::to_vec(payload);
    let serialization_elapsed_us = serialization_started_at.elapsed().as_micros();

    match result {
        Ok(json) => {
            session_stats::record(
                "session_detail_serialize_stats",
                &[
                    ("session_id", detail.id.clone()),
                    ("method", detail.summary.method.clone()),
                    ("status_code", detail.summary.status_code.to_string()),
                    ("json_bytes", json.len().to_string()),
                    ("serialize_elapsed_us", serialization_elapsed_us.to_string()),
                    (
                        "resident_memory_bytes_estimate",
                        detail.resident_memory_bytes_estimate().to_string(),
                    ),
                    (
                        "raw_request_included",
                        payload.raw_request.is_some().to_string(),
                    ),
                    (
                        "raw_response_included",
                        payload.raw_response.is_some().to_string(),
                    ),
                    (
                        "request_body_text_included",
                        payload
                            .request_body
                            .as_ref()
                            .and_then(|body| body.inline_text.as_ref())
                            .is_some()
                            .to_string(),
                    ),
                    (
                        "response_body_text_included",
                        payload
                            .response_body
                            .as_ref()
                            .and_then(|body| body.inline_text.as_ref())
                            .is_some()
                            .to_string(),
                    ),
                    (
                        "request_body_storage",
                        detail
                            .request_body
                            .as_ref()
                            .map_or("none", |body| body.storage_kind())
                            .to_string(),
                    ),
                    (
                        "response_body_storage",
                        detail
                            .response_body
                            .as_ref()
                            .map_or("none", |body| body.storage_kind())
                            .to_string(),
                    ),
                ],
            );
        }
        Err(error) => {
            session_stats::record(
                "session_detail_serialize_failed",
                &[
                    ("session_id", detail.id.clone()),
                    ("serialize_elapsed_us", serialization_elapsed_us.to_string()),
                    ("error", error.to_string()),
                ],
            );
        }
    }
}

fn log_session_detail_content_stats(
    detail: &ProxySessionDetail,
    payload: &SessionDetailContentPatchPayload,
    input: &GetSessionDetailContentInput,
) {
    if !session_stats::is_enabled() {
        return;
    }

    session_stats::record(
        "session_detail_content_serialize_stats",
        &[
            ("session_id", detail.id.clone()),
            ("method", detail.summary.method.clone()),
            ("status_code", detail.summary.status_code.to_string()),
            (
                "json_bytes_estimate",
                estimate_session_detail_content_patch_bytes(payload).to_string(),
            ),
            ("measurement_mode", "estimated".to_string()),
            (
                "include_raw_request",
                input.include_raw_request.unwrap_or(false).to_string(),
            ),
            (
                "include_raw_response",
                input.include_raw_response.unwrap_or(false).to_string(),
            ),
            (
                "include_request_body_text",
                input.include_request_body_text.unwrap_or(false).to_string(),
            ),
            (
                "include_response_body_text",
                input
                    .include_response_body_text
                    .unwrap_or(false)
                    .to_string(),
            ),
            (
                "include_request_body_base64",
                input
                    .include_request_body_base64
                    .unwrap_or(false)
                    .to_string(),
            ),
            (
                "include_response_body_base64",
                input
                    .include_response_body_base64
                    .unwrap_or(false)
                    .to_string(),
            ),
        ],
    );
}

fn build_session_detail_payload(detail: &ProxySessionDetail) -> SessionDetailPayload {
    let include_raw_request = should_inline_raw_by_default(detail.request_body.as_ref());
    let include_raw_response = should_inline_raw_by_default(detail.response_body.as_ref());

    SessionDetailPayload {
        client_address: detail.client_address.clone(),
        cookies: detail.cookies.clone(),
        id: detail.id.clone(),
        query_params: detail.query_params.clone(),
        raw_request_head: detail.raw_request_head.clone(),
        raw_request: include_raw_request
            .then(|| detail.raw_request_text())
            .flatten(),
        raw_request_deferred: (!include_raw_request && detail.raw_request_head.is_some())
            .then_some(true),
        raw_response_head: detail.raw_response_head.clone(),
        raw_response: include_raw_response
            .then(|| detail.raw_response_text())
            .flatten(),
        raw_response_deferred: (!include_raw_response && detail.raw_response_head.is_some())
            .then_some(true),
        request_body: detail
            .request_body
            .as_ref()
            .map(build_lightweight_body_payload),
        request_headers: detail.request_headers.clone(),
        response_body: detail
            .response_body
            .as_ref()
            .map(build_lightweight_body_payload),
        response_headers: detail.response_headers.clone(),
        map_traces: detail.map_traces.clone(),
        rewrite_traces: detail.rewrite_traces.clone(),
        script_traces: detail.script_traces.clone(),
        throttle_traces: detail.throttle_traces.clone(),
        server_ip: detail.server_ip.clone(),
        tls_cipher_suite: detail.tls_cipher_suite.clone(),
        tls_protocol: detail.tls_protocol.clone(),
        summary: detail.summary.clone(),
        timing: detail.timing.clone(),
        timing_source: detail.timing_source.clone(),
        trailers: detail.trailers.clone(),
        h2_stream_id: detail.h2_stream_id,
    }
}

fn build_lightweight_body_payload(
    body: &aiproxy_proxy_core::ProxyBodyReference,
) -> SessionBodyPayload {
    let include_inline_text = should_inline_body_text_by_default(body);

    SessionBodyPayload {
        base64_deferred: Some(true),
        base64_text: None,
        encoding: body.encoding.clone(),
        inline_text: include_inline_text.then(|| body.inline_text()).flatten(),
        mime_type: body.mime_type.clone(),
        size_bytes: body.size_bytes,
        text_deferred: (!include_inline_text && body.can_render_as_text()).then_some(true),
        truncated: body.truncated.then_some(true),
    }
}

fn build_session_detail_content_patch(
    detail: &ProxySessionDetail,
    input: &GetSessionDetailContentInput,
) -> SessionDetailContentPatchPayload {
    SessionDetailContentPatchPayload {
        session_id: detail.id.clone(),
        raw_request: input
            .include_raw_request
            .unwrap_or(false)
            .then(|| detail.raw_request_text())
            .flatten(),
        raw_request_deferred: input.include_raw_request.unwrap_or(false).then_some(false),
        raw_response: input
            .include_raw_response
            .unwrap_or(false)
            .then(|| detail.raw_response_text())
            .flatten(),
        raw_response_deferred: input.include_raw_response.unwrap_or(false).then_some(false),
        request_body: build_body_content_patch(
            detail.request_body.as_ref(),
            input.include_request_body_text.unwrap_or(false),
            input.include_request_body_base64.unwrap_or(false),
        ),
        response_body: build_body_content_patch(
            detail.response_body.as_ref(),
            input.include_response_body_text.unwrap_or(false),
            input.include_response_body_base64.unwrap_or(false),
        ),
    }
}

fn build_body_content_patch(
    body: Option<&aiproxy_proxy_core::ProxyBodyReference>,
    include_text: bool,
    include_base64: bool,
) -> Option<SessionBodyContentPatchPayload> {
    let body = body?;

    if !include_text && !include_base64 {
        return None;
    }

    Some(SessionBodyContentPatchPayload {
        base64_deferred: include_base64.then_some(false),
        base64_text: include_base64.then(|| body.base64_text()).flatten(),
        inline_text: (include_text && body.can_render_as_text())
            .then(|| body.inline_text())
            .flatten(),
        text_deferred: include_text.then_some(false),
    })
}

fn should_inline_raw_by_default(body: Option<&aiproxy_proxy_core::ProxyBodyReference>) -> bool {
    match body {
        Some(body) => should_inline_body_text_by_default(body),
        None => true,
    }
}

fn should_inline_body_text_by_default(body: &aiproxy_proxy_core::ProxyBodyReference) -> bool {
    body.can_render_as_text()
        && body.storage_kind() == "memory"
        && body.size_bytes <= EAGER_SESSION_DETAIL_BODY_LIMIT_BYTES
}

fn estimate_session_detail_content_patch_bytes(
    payload: &SessionDetailContentPatchPayload,
) -> usize {
    payload.session_id.len()
        + payload.raw_request.as_ref().map_or(0, String::len)
        + payload.raw_response.as_ref().map_or(0, String::len)
        + estimate_session_body_content_patch_bytes(payload.request_body.as_ref())
        + estimate_session_body_content_patch_bytes(payload.response_body.as_ref())
}

fn estimate_session_body_content_patch_bytes(
    payload: Option<&SessionBodyContentPatchPayload>,
) -> usize {
    payload.map_or(0, |payload| {
        payload.inline_text.as_ref().map_or(0, String::len)
            + payload.base64_text.as_ref().map_or(0, String::len)
    })
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    state.clear_sessions();
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInsightsInput {
    pub excluded_hosts: Option<Vec<String>>,
    pub host_exact: Option<String>,
    pub session_ids: Vec<String>,
    pub host_keyword: Option<String>,
}

#[tauri::command]
pub async fn get_insights(
    state: State<'_, Arc<AppState>>,
    input: GetInsightsInput,
) -> Result<aiproxy_db::insights::InsightsResult, String> {
    let state = Arc::clone(state.inner());
    let filter = aiproxy_db::insights::InsightsFilter {
        excluded_hosts: input.excluded_hosts.unwrap_or_default(),
        host_exact: input.host_exact,
        session_ids: input.session_ids,
        host_keyword: input.host_keyword,
    };
    run_blocking_command("get_insights", move || {
        let conn = state.read_db_connection();
        let conn_guard = conn
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        aiproxy_db::insights::compute_insights(&conn_guard, &filter)
            .map_err(|e| app_error(ERR_INTERNAL, format!("compute insights: {e}")))
    })
    .await
}
