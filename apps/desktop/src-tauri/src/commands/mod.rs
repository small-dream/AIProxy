use crate::bootstrap::{AppState, BootstrapStatus, CertificateStateSnapshot, RuntimeHandles};
use crate::dev_logger::{log_debug, log_error, log_info, log_warn};
use crate::session_stats;
use crate::system_proxy::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy, SystemProxySettings,
};
use crate::workspace::WorkspaceData;
use aiproxy_proxy_core::{
    get_local_ip_addresses, global_ws_registry, send_direct_request, start_proxy_server,
    BreakpointEventEmitter, BreakpointResolution, BreakpointRule, BreakpointStage, DnsMappingRule,
    MapRule, ProxyHeaderEntry, ProxyRuntimeConfig, ProxySessionDetail, ProxySessionSummary,
    ProxyTimingBreakdown,
    RewriteRule, ScriptRule, ScriptRuleLanguage, ScriptRuleSourceType, ThrottleProfileData,
    TlsManager, WsConnectionStatus, WsDirection, WsOpcode, compile_script_rule,
};
use aiproxy_tls_manager::{detect_platform, is_cert_trusted_on_platform, CertStorage, RootCaPair};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;
use url::form_urlencoded;

const DEFAULT_PROXY_PORT: u16 = 8888;
const EAGER_SESSION_DETAIL_BODY_LIMIT_BYTES: usize = 64 * 1024;
const MAX_IMPORTED_SCRIPT_BYTES: usize = 128 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartProxyInput {
    pub workspace_id: String,
    pub port: Option<u16>,
    pub enable_ssl: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopProxyInput {
    pub workspace_id: String,
}

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextFileInput {
    pub content: String,
    pub file_name: String,
    pub reveal_in_folder: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadHarFileInput {
    pub path: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ip: Option<String>,
    summary: ProxySessionSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<ProxyTimingBreakdown>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRootCertificateInput {
    pub force_regenerate: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbInstallResult {
    pub success: bool,
    pub device_serial: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbProxyResult {
    pub success: bool,
    pub device_serial: String,
    pub proxy_address: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAndroidCertificateViaAdbInput {
    pub device_serial: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorDevice {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub runtime: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorInstallResult {
    pub success: bool,
    pub simulator_name: String,
    pub simulator_udid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIosCertificateViaSimulatorInput {
    pub simulator_udid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAndroidProxyViaAdbInput {
    pub device_serial: Option<String>,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAndroidProxyViaAdbInput {
    pub device_serial: Option<String>,
}

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
pub fn delete_sessions_except(
    input: DeleteSessionsExceptInput,
    state: State<'_, Arc<AppState>>,
) {
    state.delete_sessions_except(&input.keep_session_id);
}

#[tauri::command]
pub fn set_focused_hosts(
    input: SetFocusedHostsInput,
    state: State<'_, Arc<AppState>>,
) {
    state.set_focused_hosts(input.hosts);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendComposedRequestInput {
    #[allow(dead_code)]
    pub workspace_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: Option<String>,
}

#[tauri::command]
pub fn get_bootstrap_status(state: State<'_, Arc<AppState>>) -> BootstrapStatus {
    state.read_status()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<AppState>>) -> Vec<ProxySessionSummary> {
    state.read_sessions()
}

#[tauri::command]
pub fn get_session_detail(
    input: GetSessionDetailInput,
    state: State<'_, Arc<AppState>>,
) -> Result<SessionDetailPayload, String> {
    let detail = state
        .read_session_detail(&input.session_id)
        .ok_or_else(|| format!("captured session {} was not found", input.session_id))?;
    let payload = build_session_detail_payload(&detail);

    log_session_detail_serialization_stats(&detail, &payload);

    Ok(payload)
}

#[tauri::command]
pub fn get_session_detail_content(
    input: GetSessionDetailContentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<SessionDetailContentPatchPayload, String> {
    let detail = state
        .read_session_detail(&input.session_id)
        .ok_or_else(|| format!("captured session {} was not found", input.session_id))?;
    let payload = build_session_detail_content_patch(&detail, &input);

    log_session_detail_content_stats(&detail, &payload, &input);

    Ok(payload)
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
                input.include_response_body_text.unwrap_or(false).to_string(),
            ),
            (
                "include_request_body_base64",
                input.include_request_body_base64.unwrap_or(false).to_string(),
            ),
            (
                "include_response_body_base64",
                input.include_response_body_base64.unwrap_or(false).to_string(),
            ),
        ],
    );
}

fn build_session_detail_payload(detail: &ProxySessionDetail) -> SessionDetailPayload {
    let include_raw_request = should_inline_raw_by_default(detail.request_body.as_ref());
    let include_raw_response = should_inline_raw_by_default(detail.response_body.as_ref());

    SessionDetailPayload {
        cookies: detail.cookies.clone(),
        id: detail.id.clone(),
        query_params: detail.query_params.clone(),
        raw_request_head: detail.raw_request_head.clone(),
        raw_request: include_raw_request.then(|| detail.raw_request_text()).flatten(),
        raw_request_deferred: (!include_raw_request && detail.raw_request_head.is_some()).then_some(true),
        raw_response_head: detail.raw_response_head.clone(),
        raw_response: include_raw_response.then(|| detail.raw_response_text()).flatten(),
        raw_response_deferred: (!include_raw_response && detail.raw_response_head.is_some()).then_some(true),
        request_body: detail.request_body.as_ref().map(build_lightweight_body_payload),
        request_headers: detail.request_headers.clone(),
        response_body: detail.response_body.as_ref().map(build_lightweight_body_payload),
        response_headers: detail.response_headers.clone(),
        server_ip: detail.server_ip.clone(),
        summary: detail.summary.clone(),
        timing: detail.timing.clone(),
    }
}

fn build_lightweight_body_payload(body: &aiproxy_proxy_core::ProxyBodyReference) -> SessionBodyPayload {
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
pub fn list_script_session_trace(
    input: ListScriptSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ScriptSessionTraceOutput>, String> {
    let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
    let runs = aiproxy_db::rules::load_script_runs_for_session(&conn, &input.session_id)
        .map_err(|error| format!("load script runs: {error}"))?;
    let run_ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
    let entries = aiproxy_db::rules::load_script_run_entries(&conn, &run_ids)
        .map_err(|error| format!("load script run entries: {error}"))?;

    Ok(runs
        .into_iter()
        .map(|run| ScriptSessionTraceOutput {
            duration_ms: run.duration_ms,
            entries: entries
                .iter()
                .filter(|entry| entry.run_id == run.id)
                .map(|entry| ScriptRunEntryOutput {
                    kind: entry.kind.clone(),
                    level: entry.level.clone(),
                    key: entry.key.clone(),
                    message: entry.message.clone(),
                    payload_json: entry.payload_json.clone(),
                    sequence: entry.seq,
                })
                .collect(),
            outcome: run.outcome,
            rule_id: run.rule_id,
            stage: run.stage,
        })
        .collect())
}

#[tauri::command]
pub fn clear_sessions(state: State<'_, Arc<AppState>>) {
    state.clear_sessions();
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWsMessagesInput {
    pub session_id: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsMessageOutput {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub timestamp: String,
    pub opcode: String,
    pub payload_text: Option<String>,
    pub payload_size: usize,
    pub fin: bool,
}

#[tauri::command]
pub fn list_ws_messages(
    input: ListWsMessagesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WsMessageOutput>, String> {
    let limit = input.limit.unwrap_or(500);
    let offset = input.offset.unwrap_or(0);
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::sessions::load_ws_messages(&conn, &input.session_id, limit, offset)
        .map_err(|error| format!("list ws messages: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|r| WsMessageOutput {
            id: r.id,
            session_id: r.session_id,
            direction: r.direction,
            timestamp: r.timestamp,
            opcode: r.opcode,
            payload_text: r.payload_text,
            payload_size: r.payload_size,
            fin: r.fin,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// WebSocket connection status & injection commands
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetWsConnectionStatusInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnectionStatusOutput {
    pub status: String,
}

#[tauri::command]
pub fn get_ws_connection_status(input: GetWsConnectionStatusInput) -> WsConnectionStatusOutput {
    let registry = global_ws_registry();
    let status = registry.get_status(&input.session_id);
    WsConnectionStatusOutput {
        status: match status {
            WsConnectionStatus::Active => "active".to_string(),
            WsConnectionStatus::Closed => "closed".to_string(),
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectWsMessageInput {
    pub session_id: String,
    pub direction: String,
    pub opcode: String,
    pub payload: String,
    pub fin: Option<bool>,
}

#[tauri::command]
pub fn inject_ws_message(input: InjectWsMessageInput) -> Result<(), String> {
    let direction = match input.direction.as_str() {
        "clientToServer" => WsDirection::ClientToServer,
        "serverToClient" => WsDirection::ServerToClient,
        _ => return Err(format!("Invalid direction: {}", input.direction)),
    };
    let opcode = match input.opcode.as_str() {
        "text" => WsOpcode::Text,
        "binary" => WsOpcode::Binary,
        "close" => WsOpcode::Close,
        "ping" => WsOpcode::Ping,
        "pong" => WsOpcode::Pong,
        _ => return Err(format!("Invalid opcode: {}", input.opcode)),
    };
    let registry = global_ws_registry();
    let request = aiproxy_proxy_core::WsInjectRequest {
        direction,
        opcode,
        payload: input.payload,
        fin: input.fin.unwrap_or(true),
    };
    registry.inject(&input.session_id, request)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWsMessagesInput {
    pub session_id: String,
    pub query: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[tauri::command]
pub fn search_ws_messages(
    input: SearchWsMessagesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WsMessageOutput>, String> {
    let limit = input.limit.unwrap_or(500);
    let offset = input.offset.unwrap_or(0);
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::sessions::search_ws_messages(
        &conn,
        &input.session_id,
        &input.query,
        limit,
        offset,
    )
    .map_err(|error| format!("search ws messages: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|r| WsMessageOutput {
            id: r.id,
            session_id: r.session_id,
            direction: r.direction,
            timestamp: r.timestamp,
            opcode: r.opcode,
            payload_text: r.payload_text,
            payload_size: r.payload_size,
            fin: r.fin,
        })
        .collect())
}

#[tauri::command]
pub fn get_certificate_status(
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    get_certificate_status_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn generate_root_certificate(
    input: GenerateRootCertificateInput,
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    generate_root_certificate_impl(input, Arc::clone(state.inner()))
}

#[tauri::command]
pub fn open_certificate_install_guide(
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    open_certificate_install_guide_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn launch_certificate_installer(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    launch_certificate_installer_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn list_android_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    list_android_adb_devices_impl()
}

#[tauri::command]
pub fn install_android_certificate_via_adb(
    input: InstallAndroidCertificateViaAdbInput,
    state: State<'_, Arc<AppState>>,
) -> Result<AndroidAdbInstallResult, String> {
    install_android_certificate_via_adb_impl(input, Arc::clone(state.inner()))
}

#[tauri::command]
pub fn list_ios_simulators() -> Result<Vec<IosSimulatorDevice>, String> {
    list_ios_simulators_impl()
}

#[tauri::command]
pub fn install_ios_certificate_via_simulator(
    input: InstallIosCertificateViaSimulatorInput,
    state: State<'_, Arc<AppState>>,
) -> Result<IosSimulatorInstallResult, String> {
    install_ios_certificate_via_simulator_impl(input, Arc::clone(state.inner()))
}

#[tauri::command]
pub fn set_android_proxy_via_adb(
    input: SetAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    set_android_proxy_via_adb_impl(input)
}

#[tauri::command]
pub fn clear_android_proxy_via_adb(
    input: ClearAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    clear_android_proxy_via_adb_impl(input)
}

#[tauri::command]
pub async fn start_proxy(
    input: StartProxyInput,
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    start_proxy_impl(input, Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn stop_proxy(
    input: StopProxyInput,
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    stop_proxy_impl(input, Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn enable_system_proxy(
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    enable_system_proxy_impl(Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn disable_system_proxy(
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    disable_system_proxy_impl(Arc::clone(state.inner())).await
}

#[tauri::command]
pub fn save_text_file(
    input: SaveTextFileInput,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Unable to locate the Downloads directory.".to_string())?;
    let target_path = next_available_export_path(&downloads_dir, &input.file_name);

    std::fs::write(&target_path, input.content.as_bytes())
        .map_err(|error| format!("write exported file: {error}"))?;

    if input.reveal_in_folder.unwrap_or(false) {
        app.opener()
            .reveal_item_in_dir(&target_path)
            .map_err(|error| format!("reveal exported file: {error}"))?;
    }

    Ok(target_path.display().to_string())
}

#[tauri::command]
pub fn read_har_file(input: ReadHarFileInput) -> Result<String, String> {
    let path = Path::new(&input.path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "HAR file must end with .har".to_string())?;

    if extension != "har" {
        return Err("HAR file must end with .har".to_string());
    }

    std::fs::read_to_string(path).map_err(|error| format!("read HAR file: {error}"))
}

#[tauri::command]
pub fn get_local_ip() -> Vec<String> {
    get_local_ip_addresses()
}

#[tauri::command]
pub async fn send_composed_request(
    input: SendComposedRequestInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ProxySessionDetail, String> {
    let detail = send_direct_request(input.method, input.url, input.headers, input.body).await?;
    let session_id = detail.id.clone();
    state.upsert_session(detail.clone());

    log_info(
        "desktop.commands",
        "send_composed_request_succeeded",
        &[
            ("session_id", session_id),
            (
                "status_code",
                detail.summary.status_code.to_string(),
            ),
        ],
    );

    Ok(detail)
}

async fn start_proxy_impl(
    input: StartProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    let should_reapply_system_proxy = state.read_status().system_proxy_enabled;
    let port = input.port.unwrap_or(DEFAULT_PROXY_PORT);
    let enable_ssl = input.enable_ssl.unwrap_or(true);

    ProxyRuntimeConfig {
        port,
        ssl_enabled: enable_ssl,
    }
    .validate()
    .map_err(|message| message.to_string())?;

    log_info(
        "desktop.commands",
        "start_proxy_requested",
        &[
            ("workspace_id", input.workspace_id.clone()),
            ("port", port.to_string()),
            ("ssl_enabled", enable_ssl.to_string()),
            (
                "system_proxy_enabled",
                should_reapply_system_proxy.to_string(),
            ),
        ],
    );

    if shutdown_proxy_runtime(Arc::clone(&state)).await {
        log_debug(
            "desktop.commands",
            "previous_proxy_runtime_found",
            &[("workspace_id", input.workspace_id.clone())],
        );
    }

    // Resolve TLS manager for SSL interception
    let tls_manager = if enable_ssl {
        let existing = state.read_tls_manager();
        match existing {
            Some(m) => Some(m),
            None => {
                // Try loading existing root CA from disk
                match try_load_tls_manager() {
                    Ok(m) => {
                        state.set_tls_manager(Arc::clone(&m));
                        Some(m)
                    }
                    Err(_) => {
                        return Err(
                            "SSL interception requires a root certificate. Generate one on the Certificates page.".to_string()
                        );
                    }
                }
            }
        }
    } else {
        None
    };

    let breakpoint_manager = state.read_breakpoint_manager();
    let rewrite_manager = state.read_rewrite_manager();
    let map_manager = state.read_map_manager();
    let script_manager = state.read_script_manager();
    let throttle_manager = state.read_throttle_manager();

    let event_emitter: Option<BreakpointEventEmitter> = state.read_app_handle().map(|handle| {
        Arc::new(move |event: &str, payload: serde_json::Value| {
            let _ = handle.emit(event, payload);
        }) as BreakpointEventEmitter
    });

    let dns_manager = state.read_dns_manager();

    let started_proxy_server = start_proxy_server(
        ProxyRuntimeConfig {
            port,
            ssl_enabled: enable_ssl,
        },
        tls_manager,
        Some(breakpoint_manager),
        Some(rewrite_manager),
        Some(map_manager),
        Some(script_manager),
        Some(throttle_manager),
        Some(dns_manager),
        Some(input.workspace_id.clone()),
        event_emitter,
    )
    .await?;

    let mut session_receiver = started_proxy_server.session_receiver;
    let mut ws_message_receiver = started_proxy_server.ws_message_receiver;
    let state_for_collector = Arc::clone(&state);
    let state_for_ws = Arc::clone(&state);
    let collector_handle = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                session = session_receiver.recv() => {
                    match session {
                        Some(session) => state_for_collector.upsert_session(session),
                        None => break,
                    }
                }
                ws_msg = ws_message_receiver.recv() => {
                    match ws_msg {
                        Some(msg) => {
                            let conn = state_for_ws.read_db_connection().lock().expect("db mutex");
                            let row = aiproxy_db::sessions::WsMessageRow {
                                id: msg.id.clone(),
                                session_id: msg.session_id.clone(),
                                direction: msg.direction.clone(),
                                timestamp: msg.timestamp.clone(),
                                opcode: msg.opcode.clone(),
                                payload_text: msg.payload_text.clone(),
                                payload_size: msg.payload_size,
                                fin: msg.fin,
                            };
                            if let Err(e) = aiproxy_db::sessions::insert_ws_message(&conn, &row) {
                                crate::dev_logger::log_error(
                                    "desktop.ws_collector",
                                    "insert_ws_message_failed",
                                    &[("error", e)],
                                );
                            }
                            drop(conn);

                            // Emit to frontend
                            if let Some(handle) = state_for_ws.read_app_handle() {
                                let _ = handle.emit("ws-message", serde_json::json!({
                                    "id": msg.id,
                                    "sessionId": msg.session_id,
                                    "direction": msg.direction,
                                    "timestamp": msg.timestamp,
                                    "opcode": msg.opcode,
                                    "payloadText": msg.payload_text,
                                    "payloadSize": msg.payload_size,
                                    "fin": msg.fin,
                                }));
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    state.set_runtime(RuntimeHandles {
        collector_handle,
        proxy_server_handle: started_proxy_server.server_handle,
    });

    let status = state.start_proxy(
        started_proxy_server.bound_port,
        enable_ssl,
        input.workspace_id,
    );

    if should_reapply_system_proxy {
        apply_system_proxy_settings(&SystemProxySettings::localhost(status.port))?;
    }

    log_info(
        "desktop.commands",
        "start_proxy_succeeded",
        &[
            ("workspace_id", status.active_workspace_id.clone().unwrap_or_default()),
            ("bound_port", status.port.to_string()),
            ("ssl_enabled", status.ssl_enabled.to_string()),
        ],
    );

    Ok(status)
}

async fn stop_proxy_impl(
    input: StopProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    log_info(
        "desktop.commands",
        "stop_proxy_requested",
        &[
            ("workspace_id", input.workspace_id.clone()),
            ("reason", "user_request".to_string()),
        ],
    );

    if state.read_status().system_proxy_enabled {
        if let Err(error) = disable_system_proxy_impl(Arc::clone(&state)).await {
            log_warn(
                "desktop.commands",
                "stop_proxy_system_proxy_restore_failed",
                &[
                    ("workspace_id", input.workspace_id.clone()),
                    ("error", error),
                ],
            );
        }
    }

    let _ = shutdown_proxy_runtime(Arc::clone(&state)).await;

    let status = state.stop_proxy(input.workspace_id);

    log_info(
        "desktop.commands",
        "stop_proxy_succeeded",
        &[
            (
                "workspace_id",
                status.active_workspace_id.clone().unwrap_or_default(),
            ),
            ("running", status.running.to_string()),
        ],
    );

    Ok(status)
}

pub(crate) async fn shutdown_proxy_runtime(state: Arc<AppState>) -> bool {
    let Some(runtime_handles) = state.take_runtime() else {
        return false;
    };

    state.read_breakpoint_manager().cancel_all();
    runtime_handles.collector_handle.abort();
    let _ = runtime_handles.collector_handle.await;
    runtime_handles.proxy_server_handle.shutdown().await;

    true
}

async fn enable_system_proxy_impl(state: Arc<AppState>) -> Result<BootstrapStatus, String> {
    let status = state.read_status();

    if !status.running {
        log_warn(
            "desktop.commands",
            "enable_system_proxy_rejected",
            &[(
                "reason",
                "proxy_must_be_running_before_enabling_system_proxy".to_string(),
            )],
        );
        return Err("proxy must be running before enabling the system proxy".to_string());
    }

    let settings = SystemProxySettings::localhost(status.port);

    if state.has_system_proxy_snapshot() {
        apply_system_proxy_settings(&settings)?;
    } else {
        let snapshot = capture_system_proxy_snapshot()?;
        apply_system_proxy_settings_with_pre_snapshot(&settings, snapshot.clone())?;
        state.store_system_proxy_snapshot(snapshot);
    }

    log_info(
        "desktop.commands",
        "enable_system_proxy_succeeded",
        &[
            ("port", status.port.to_string()),
            ("endpoint", settings.endpoint()),
        ],
    );

    Ok(state.set_system_proxy_enabled(true))
}

async fn disable_system_proxy_impl(state: Arc<AppState>) -> Result<BootstrapStatus, String> {
    if let Some(snapshot) = state.take_system_proxy_snapshot() {
        if let Err(error) = restore_system_proxy(&snapshot) {
            state.store_system_proxy_snapshot(snapshot);

            log_error(
                "desktop.commands",
                "disable_system_proxy_restore_failed",
                &[("error", error.clone())],
            );

            return Err(error);
        }
    }

    log_info(
        "desktop.commands",
        "disable_system_proxy_succeeded",
        &[("reason", "user_request".to_string())],
    );

    Ok(state.set_system_proxy_enabled(false))
}

// --- Certificate command implementations ---

fn get_certificate_status_impl(state: Arc<AppState>) -> Result<CertificateStateSnapshot, String> {
    let platform = detect_platform();

    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        let status = CertificateStateSnapshot {
            cert_path: None,
            fingerprint: None,
            trusted: false,
            platform: platform.to_string(),
        };
        state.update_cert_status(status.clone());
        return Ok(status);
    }

    let cert_pem = storage.load_root_cert_pem()
        .map_err(|e| format!("failed to read root cert: {e}"))?;
    let key_pem = storage.load_root_key_pem()
        .map_err(|e| format!("failed to read root key: {e}"))?;

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| format!("failed to load root CA: {e}"))?;

    #[cfg(target_os = "macos")]
    storage
        .ensure_root_cert_install_copy()
        .map_err(|e| format!("failed to prepare installable root cert: {e}"))?;

    let trusted = is_cert_trusted_on_platform(storage.root_cert_path(), platform);
    let cert_path = certificate_display_path(&storage, platform);

    let status = CertificateStateSnapshot {
        cert_path: Some(cert_path),
        fingerprint: Some(root_ca.fingerprint().to_string()),
        trusted,
        platform: platform.to_string(),
    };

    state.update_cert_status(status.clone());

    Ok(status)
}

fn generate_root_certificate_impl(
    input: GenerateRootCertificateInput,
    state: Arc<AppState>,
) -> Result<CertificateStateSnapshot, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    // If already exists and not forcing regeneration, return existing status
    if storage.root_cert_exists() && !input.force_regenerate.unwrap_or(false) {
        return get_certificate_status_impl(state);
    }

    // Generate new root CA
    let root_ca = RootCaPair::generate()
        .map_err(|e| format!("failed to generate root CA: {e}"))?;

    storage.save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
        .map_err(|e| format!("failed to save root CA: {e}"))?;

    // Create server config for MITM
    let server_config = root_ca.create_server_config(&storage)
        .map_err(|e| format!("failed to create TLS server config: {e}"))?;

    // Store TlsManager in AppState
    let tls_manager = Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
    });
    state.set_tls_manager(tls_manager);

    let status = get_certificate_status_impl(state)?;

    #[cfg(target_os = "macos")]
    if let Some(cert_path) = status.cert_path.as_deref() {
        if let Err(error) = open_certificate_file(cert_path) {
            log_warn(
                "desktop.commands",
                "generate_root_certificate_auto_open_failed",
                &[("error", error)],
            );
        }
    }

    Ok(status)
}

fn open_certificate_install_guide_impl(
    state: Arc<AppState>,
) -> Result<serde_json::Value, String> {
    let platform = detect_platform();
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status.cert_path.clone().unwrap_or_default();

    let steps = match platform {
        aiproxy_tls_manager::Platform::Windows => vec![
            serde_json::json!({"order": 1, "description": "Generate a root certificate, then click Install Certificate... to open the Windows certificate installer."}),
            serde_json::json!({"order": 2, "description": "In the dialog, click Install Certificate..."}),
            serde_json::json!({"order": 3, "description": "Select Current User or Local Machine (Local Machine requires administrator), then click Next."}),
            serde_json::json!({"order": 4, "description": "Select 'Place all certificates in the following store', click Browse, and choose Trusted Root Certification Authorities. Click Next."}),
            serde_json::json!({"order": 5, "description": "Click Finish. Accept the security warning to confirm trust."}),
            serde_json::json!({"order": 6, "description": "Click Refresh Status to verify the certificate is now trusted."}),
        ],
        aiproxy_tls_manager::Platform::Macos => vec![
            serde_json::json!({"order": 1, "description": format!("Double-click the certificate file at: {}", cert_path)}),
            serde_json::json!({"order": 2, "description": "Open Keychain Access. The certificate will appear in the 'login' keychain."}),
            serde_json::json!({"order": 3, "description": "Drag the certificate to the 'System' keychain in the left sidebar."}),
            serde_json::json!({"order": 4, "description": "Double-click the certificate in System keychain, expand Trust, and set 'When using this certificate' to 'Always Trust'."}),
            serde_json::json!({"order": 5, "description": "Close the window. You will be prompted for your administrator password."}),
            serde_json::json!({"order": 6, "description": "Restart your browser for the change to take effect."}),
        ],
        aiproxy_tls_manager::Platform::Linux => vec![
            serde_json::json!({"order": 1, "description": format!("Copy the certificate to the system CA directory: sudo cp {} /usr/local/share/ca-certificates/aiproxy-root-ca.crt", cert_path)}),
            serde_json::json!({"order": 2, "description": "Update the CA store: sudo update-ca-certificates"}),
            serde_json::json!({"order": 3, "description": "Restart your browser for the change to take effect."}),
        ],
    };

    Ok(serde_json::json!({
        "success": true,
        "certPath": cert_path,
        "platform": platform.to_string(),
        "steps": steps,
    }))
}

fn launch_certificate_installer_impl(state: Arc<AppState>) -> Result<(), String> {
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status
        .cert_path
        .ok_or_else(|| "No certificate found. Generate one first.".to_string())?;

    open_certificate_file(&cert_path)
}

fn list_android_adb_devices_impl() -> Result<Vec<AndroidAdbDevice>, String> {
    read_adb_devices()
}

fn install_android_certificate_via_adb_impl(
    input: InstallAndroidCertificateViaAdbInput,
    _state: Arc<AppState>,
) -> Result<AndroidAdbInstallResult, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("No certificate found. Generate one first.".to_string());
    }

    storage
        .ensure_root_cert_install_copy()
        .map_err(|e| format!("failed to prepare installable root cert: {e}"))?;

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let remote_path = "/sdcard/Download/aiproxy-root-ca.cer";

    let adb = resolve_adb_path()?;
    let push_output = std::process::Command::new(&adb)
        .args(["-s", &device_serial, "push"])
        .arg(storage.root_cert_install_path())
        .arg(remote_path)
        .output()
        .map_err(adb_spawn_error)?;

    if !push_output.status.success() {
        return Err(format!(
            "Failed to push certificate to Android device: {}",
            format_command_output(&push_output)
        ));
    }

    let launch_output = std::process::Command::new(&adb)
        .args([
            "-s",
            &device_serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.settings.SECURITY_SETTINGS",
        ])
        .output()
        .map_err(adb_spawn_error)?;

    if !launch_output.status.success() {
        return Err(format!(
            "Failed to open Android Security settings: {}",
            format_command_output(&launch_output)
        ));
    }

    let launch_text = format_command_output(&launch_output);
    if launch_text.contains("Error:") {
        return Err(format!(
            "Android reported an error while opening Security settings: {}",
            launch_text
        ));
    }

    log_info(
        "desktop.commands",
        "install_android_certificate_via_adb_succeeded",
        &[
            ("device_serial", device_serial.clone()),
            ("remote_path", remote_path.to_string()),
        ],
    );

    Ok(AndroidAdbInstallResult {
        success: true,
        device_serial,
        remote_path: remote_path.to_string(),
    })
}

fn list_ios_simulators_impl() -> Result<Vec<IosSimulatorDevice>, String> {
    read_ios_simulators()
}

fn install_ios_certificate_via_simulator_impl(
    input: InstallIosCertificateViaSimulatorInput,
    _state: Arc<AppState>,
) -> Result<IosSimulatorInstallResult, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("No certificate found. Generate one first.".to_string());
    }

    let simulator = resolve_ios_simulator(input.simulator_udid.as_deref())?;

    let output = std::process::Command::new("xcrun")
        .args([
            "simctl",
            "keychain",
            &simulator.udid,
            "add-root-cert",
        ])
        .arg(storage.root_cert_path())
        .output()
        .map_err(xcrun_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to install the root certificate into iOS Simulator `{}`: {}",
            simulator.name,
            format_command_output(&output)
        ));
    }

    log_info(
        "desktop.commands",
        "install_ios_certificate_via_simulator_succeeded",
        &[
            ("simulator_name", simulator.name.clone()),
            ("simulator_udid", simulator.udid.clone()),
        ],
    );

    Ok(IosSimulatorInstallResult {
        success: true,
        simulator_name: simulator.name,
        simulator_udid: simulator.udid,
    })
}

fn set_android_proxy_via_adb_impl(
    input: SetAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    let host = input.host.trim();
    if host.is_empty() {
        return Err("Android proxy host cannot be empty.".to_string());
    }

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let proxy_address = format!("{host}:{}", input.port);

    run_adb_shell_command(
        &device_serial,
        &["settings", "put", "global", "http_proxy", &proxy_address],
    )?;

    log_info(
        "desktop.commands",
        "set_android_proxy_via_adb_succeeded",
        &[
            ("device_serial", device_serial.clone()),
            ("proxy_address", proxy_address.clone()),
        ],
    );

    Ok(AndroidAdbProxyResult {
        success: true,
        device_serial,
        proxy_address: Some(proxy_address),
    })
}

fn clear_android_proxy_via_adb_impl(
    input: ClearAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;

    run_adb_shell_command(
        &device_serial,
        &["settings", "put", "global", "http_proxy", ":0"],
    )?;

    log_info(
        "desktop.commands",
        "clear_android_proxy_via_adb_succeeded",
        &[("device_serial", device_serial.clone())],
    );

    Ok(AndroidAdbProxyResult {
        success: true,
        device_serial,
        proxy_address: None,
    })
}

fn open_certificate_file(cert_path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["cryptext.dll,CryptExtOpenCER", cert_path])
            .spawn()
            .map_err(|e| format!("Failed to open certificate installer: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Keychain Access", cert_path])
            .spawn()
            .map_err(|e| format!("Failed to open certificate in Keychain Access: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(cert_path)
            .spawn()
            .map_err(|e| format!("Failed to open certificate file: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = cert_path;
        Err("Certificate launcher is not supported on this platform.".to_string())
    }
}

fn read_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
        .args(["devices", "-l"])
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to query adb devices: {}",
            format_command_output(&output)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let serial = parts.next().unwrap_or_default();
        let state = parts.next().unwrap_or_default();

        if serial.is_empty() || state.is_empty() {
            continue;
        }

        let mut model = None;
        let mut product = None;
        let mut device = None;
        let mut transport_id = None;

        for segment in parts {
            if let Some(value) = segment.strip_prefix("model:") {
                model = Some(value.replace('_', " "));
                continue;
            }

            if let Some(value) = segment.strip_prefix("product:") {
                product = Some(value.to_string());
                continue;
            }

            if let Some(value) = segment.strip_prefix("device:") {
                device = Some(value.to_string());
                continue;
            }

            if let Some(value) = segment.strip_prefix("transport_id:") {
                transport_id = Some(value.to_string());
            }
        }

        devices.push(AndroidAdbDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
            product,
            device,
            transport_id,
        });
    }

    Ok(devices)
}

fn read_ios_simulators() -> Result<Vec<IosSimulatorDevice>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("iOS Simulator quick actions are only supported on macOS.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("xcrun")
            .args(["simctl", "list", "devices", "available", "--json"])
            .output()
            .map_err(xcrun_spawn_error)?;

        if !output.status.success() {
            return Err(format!(
                "Failed to query iOS Simulators: {}",
                format_command_output(&output)
            ));
        }

        let payload: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("failed to parse simulator list: {error}"))?;
        let Some(devices_by_runtime) = payload.get("devices").and_then(|value| value.as_object()) else {
            return Err("Simulator list did not include a devices map.".to_string());
        };

        let mut simulators = Vec::new();

        for (runtime_key, entries) in devices_by_runtime {
            let Some(entries) = entries.as_array() else {
                continue;
            };

            for entry in entries {
                let state = entry
                    .get("state")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                if state != "Booted" {
                    continue;
                }

                let is_available = entry
                    .get("isAvailable")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true);
                if !is_available {
                    continue;
                }

                let name = entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let udid = entry
                    .get("udid")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();

                if name.is_empty() || udid.is_empty() {
                    continue;
                }

                simulators.push(IosSimulatorDevice {
                    name: name.to_string(),
                    udid: udid.to_string(),
                    state: state.to_string(),
                    runtime: format_ios_runtime_name(runtime_key),
                });
            }
        }

        Ok(simulators)
    }
}

fn resolve_adb_target_device(requested_serial: Option<&str>) -> Result<String, String> {
    let devices = read_adb_devices()?;
    let ready_devices = devices
        .iter()
        .filter(|device| device.state == "device")
        .collect::<Vec<_>>();

    if let Some(requested_serial) = requested_serial {
        let Some(device) = devices.iter().find(|device| device.serial == requested_serial) else {
            return Err(format!(
                "Android device `{requested_serial}` was not found in adb devices. Refresh the device list and try again."
            ));
        };

        if device.state != "device" {
            return Err(format!(
                "Android device `{requested_serial}` is in `{}` state. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
                device.state
            ));
        }

        return Ok(device.serial.clone());
    }

    if ready_devices.is_empty() {
        let unavailable_devices = devices
            .iter()
            .map(|device| format!("{} ({})", device.serial, device.state))
            .collect::<Vec<_>>();

        if unavailable_devices.is_empty() {
            return Err(
                "No Android device found via adb. Connect one device and enable USB debugging, then try again."
                    .to_string(),
            );
        }

        return Err(format!(
            "No ready Android device found via adb. Current device states: {}. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
            unavailable_devices.join(", ")
        ));
    }

    if ready_devices.len() > 1 {
        return Err(format!(
            "Multiple ready Android devices are connected via adb ({}). Choose one device in the Certificates page, then try again.",
            ready_devices
                .iter()
                .map(|device| device.serial.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(ready_devices[0].serial.clone())
}

fn resolve_ios_simulator(requested_udid: Option<&str>) -> Result<IosSimulatorDevice, String> {
    let simulators = read_ios_simulators()?;

    if let Some(requested_udid) = requested_udid {
        let Some(simulator) = simulators.iter().find(|simulator| simulator.udid == requested_udid) else {
            return Err(format!(
                "iOS Simulator `{requested_udid}` was not found in the booted simulator list. Refresh the simulator list and try again."
            ));
        };

        return Ok(simulator.clone());
    }

    if simulators.is_empty() {
        return Err(
            "No booted iOS Simulator was found. Launch a simulator first, then try again."
                .to_string(),
        );
    }

    if simulators.len() > 1 {
        return Err(format!(
            "Multiple booted iOS Simulators were found ({}). Choose one in the Mobile Setup page, then try again.",
            simulators
                .iter()
                .map(|simulator| simulator.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(simulators[0].clone())
}

fn resolve_adb_path() -> Result<std::path::PathBuf, String> {
    // 1. Try bare "adb" from PATH
    if let Ok(output) = std::process::Command::new("adb")
        .arg("--version")
        .output()
    {
        if output.status.success() {
            return Ok(std::path::PathBuf::from("adb"));
        }
    }

    // 2. Check ANDROID_HOME / ANDROID_SDK_ROOT
    for env_var in &["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(sdk_dir) = std::env::var(env_var) {
            let adb = std::path::Path::new(&sdk_dir).join("platform-tools").join("adb");
            if adb.exists() {
                return Ok(adb);
            }
        }
    }

    // 3. Check common install locations per platform
    if let Some(home) = dirs::home_dir() {
        let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
            vec![
                home.join("Library/Android/sdk/platform-tools/adb"),
            ]
        } else if cfg!(target_os = "linux") {
            vec![
                home.join("Android/Sdk/platform-tools/adb"),
                home.join(".android/sdk/platform-tools/adb"),
            ]
        } else {
            vec![]
        };

        for adb in candidates {
            if adb.exists() {
                return Ok(adb);
            }
        }
    }

    Err("adb was not found. Install Android Platform Tools (https://developer.android.com/tools/releases/platform-tools) and ensure `adb` is on PATH or ANDROID_HOME is set.".to_string())
}

fn adb_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return "adb was not found in PATH. Install Android Platform Tools and make sure the `adb` command is available.".to_string();
    }

    format!("failed to run adb: {error}")
}

fn xcrun_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return "xcrun was not found in PATH. Install Xcode Command Line Tools and make sure the `xcrun` command is available.".to_string();
    }

    format!("failed to run xcrun: {error}")
}

fn run_adb_shell_command(device_serial: &str, shell_args: &[&str]) -> Result<(), String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
        .args(["-s", device_serial, "shell"])
        .args(shell_args)
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to run `adb shell {}` on Android device `{}`: {}",
            shell_args.join(" "),
            device_serial,
            format_command_output(&output)
        ));
    }

    let output_text = format_command_output(&output);
    if output_text.contains("Exception occurred while executing")
        || output_text.starts_with("Error:")
    {
        return Err(format!(
            "Android rejected `adb shell {}` on `{}`: {}",
            shell_args.join(" "),
            device_serial,
            output_text
        ));
    }

    Ok(())
}

fn format_ios_runtime_name(runtime_key: &str) -> String {
    let runtime = runtime_key
        .rsplit('.')
        .next()
        .unwrap_or(runtime_key)
        .replace('-', " ");

    if let Some(version) = runtime.strip_prefix("iOS ") {
        return format!("iOS {}", version.replace(' ', "."));
    }

    runtime
}

fn format_command_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}; {stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => "no output".to_string(),
    }
}

fn certificate_display_path(storage: &CertStorage, platform: aiproxy_tls_manager::Platform) -> String {
    match platform {
        aiproxy_tls_manager::Platform::Macos => storage
            .root_cert_install_path()
            .to_string_lossy()
            .to_string(),
        _ => storage.root_cert_path().to_string_lossy().to_string(),
    }
}

/// Try to load a TlsManager from an existing root CA on disk.
fn try_load_tls_manager() -> Result<Arc<TlsManager>, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("cert storage resolve: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("no root certificate found".to_string());
    }

    let cert_pem = storage.load_root_cert_pem()
        .map_err(|e| format!("read cert: {e}"))?;
    let key_pem = storage.load_root_key_pem()
        .map_err(|e| format!("read key: {e}"))?;

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| format!("load root CA: {e}"))?;

    let server_config = root_ca.create_server_config(&storage)
        .map_err(|e| format!("create server config: {e}"))?;

    Ok(Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
    }))
}

// --- Breakpoint commands ---

#[tauri::command]
pub fn list_breakpoint_rules(state: State<'_, Arc<AppState>>) -> Vec<BreakpointRule> {
    state.read_breakpoint_manager().list_rules()
}

#[tauri::command]
pub fn set_breakpoint_rules(rules: Vec<BreakpointRule>, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    // Persist to DB first
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let rows: Vec<aiproxy_db::rules::BreakpointRuleRow> = rules
            .iter()
            .map(|r| aiproxy_db::rules::BreakpointRuleRow {
                id: r.id.clone(),
                enabled: r.enabled,
                url_pattern: r.url_pattern.clone(),
                methods: serde_json::to_string(&r.methods).unwrap_or_default(),
                stage: match r.stage {
                    BreakpointStage::Request => "Request".to_string(),
                    BreakpointStage::Response => "Response".to_string(),
                },
            })
            .collect();
        aiproxy_db::rules::replace_breakpoint_rules(&conn, &rows)
            .map_err(|error| format!("set breakpoint rules: {error}"))?;
    }

    state.read_breakpoint_manager().set_rules(rules);
    Ok(())
}

#[tauri::command]
pub fn resolve_breakpoint(
    resolution: BreakpointResolution,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let session_id = resolution.session_id.clone();
    state
        .read_breakpoint_manager()
        .resolve(&session_id, resolution)
}

// --- Rewrite commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRewriteRulesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_rewrite_rules(
    input: ListRewriteRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<RewriteRule> {
    state.read_rewrite_manager().list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_rewrite_rule(
    input: RewriteRule,
    state: State<'_, Arc<AppState>>,
) -> Result<RewriteRule, String> {
    // Persist to DB first
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::RewriteRuleRow {
            id: input.id.clone(),
            workspace_id: input.workspace_id.clone(),
            name: input.name.clone(),
            note: input.note.clone(),
            enabled: input.enabled,
            priority: input.priority,
            match_methods: serde_json::to_string(&input.r#match.methods).unwrap_or_default(),
            match_stage: input.r#match.stage.clone(),
            match_url_pattern: input.r#match.url_pattern.clone(),
            rewrite_type: input.rewrite_type.clone(),
            payload: input.payload.to_string(),
        };
        aiproxy_db::rules::save_rewrite_rule(&conn, &row)
            .map_err(|error| format!("save rewrite rule: {error}"))?;
    }

    Ok(state.read_rewrite_manager().save_rule(input))
}

// --- Map commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMapRulesInput {
    pub workspace_id: String,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListScriptRulesInput {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadScriptSourceFileInput {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSourceFileOutput {
    pub file_name: String,
    pub language: String,
    pub path: String,
    pub source_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListScriptSessionTraceInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunEntryOutput {
    pub kind: String,
    pub level: Option<String>,
    pub key: Option<String>,
    pub message: Option<String>,
    pub payload_json: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSessionTraceOutput {
    pub duration_ms: u128,
    pub entries: Vec<ScriptRunEntryOutput>,
    pub outcome: String,
    pub rule_id: String,
    pub stage: String,
}

#[tauri::command]
pub fn list_map_rules(
    input: ListMapRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<MapRule> {
    state.read_map_manager().list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .filter(|r| match &input.mode {
            Some(mode) => r.mode == *mode,
            None => true,
        })
        .collect()
}

#[tauri::command]
pub fn save_map_rule(
    input: MapRule,
    state: State<'_, Arc<AppState>>,
) -> Result<MapRule, String> {
    // Persist to DB first
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::MapRuleRow {
            id: input.id.clone(),
            workspace_id: input.workspace_id.clone(),
            mode: input.mode.clone(),
            name: input.name.clone(),
            note: input.note.clone(),
            enabled: input.enabled,
            preserve_path: input.preserve_path,
            preserve_query: input.preserve_query,
            priority: input.priority,
            source_pattern: input.source_pattern.clone(),
            target_value: input.target_value.clone(),
        };
        aiproxy_db::rules::save_map_rule(&conn, &row)
            .map_err(|error| format!("save map rule: {error}"))?;
    }

    Ok(state.read_map_manager().save_rule(input))
}

// --- Script rule commands ---

#[tauri::command]
pub fn list_script_rules(
    input: ListScriptRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<ScriptRule> {
    state
        .read_script_manager()
        .list_rules()
        .into_iter()
        .filter(|rule| rule.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_script_rule(
    input: ScriptRule,
    state: State<'_, Arc<AppState>>,
) -> Result<ScriptRule, String> {
    let compiled = compile_script_rule(input)?;

    {
        let conn = state
            .read_db_connection()
            .lock()
            .expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::ScriptRuleRow {
            id: compiled.rule.id.clone(),
            workspace_id: compiled.rule.workspace_id.clone(),
            name: compiled.rule.name.clone(),
            note: compiled.rule.note.clone(),
            enabled: compiled.rule.enabled,
            priority: compiled.rule.priority,
            match_methods: serde_json::to_string(&compiled.rule.r#match.methods).unwrap_or_default(),
            match_stage: compiled.rule.r#match.stage.clone(),
            match_url_pattern: compiled.rule.r#match.url_pattern.clone(),
            language: match compiled.rule.language {
                ScriptRuleLanguage::JavaScript => "javascript".to_string(),
                ScriptRuleLanguage::TypeScript => "typescript".to_string(),
            },
            source_type: match compiled.rule.source_type {
                ScriptRuleSourceType::Inline => "inline".to_string(),
                ScriptRuleSourceType::FileImport => "fileImport".to_string(),
            },
            source_code: compiled.rule.source_code.clone(),
            source_path: compiled.rule.source_path.clone(),
            entrypoints: serde_json::to_string(&compiled.rule.entrypoints).unwrap_or_else(|_| "{}".to_string()),
            compiled_code: compiled.compiled_code.clone(),
            source_map: compiled.source_map.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        aiproxy_db::rules::save_script_rule(&conn, &row)
            .map_err(|error| format!("save script rule: {error}"))?;
    }

    Ok(state.read_script_manager().save_rule(compiled))
}

#[tauri::command]
pub fn read_script_source_file(
    input: ReadScriptSourceFileInput,
) -> Result<ScriptSourceFileOutput, String> {
    let path = Path::new(&input.path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "script file must end with .js, .mjs, .ts, or .mts".to_string())?;
    let language = match extension.as_str() {
        "js" | "mjs" => "javascript",
        "ts" | "mts" => "typescript",
        _ => return Err("unsupported script file extension".to_string()),
    };

    let bytes = std::fs::read(path).map_err(|error| format!("read script file: {error}"))?;
    if bytes.len() > MAX_IMPORTED_SCRIPT_BYTES {
        return Err(format!(
            "script file exceeds the {} KB limit",
            MAX_IMPORTED_SCRIPT_BYTES / 1024
        ));
    }

    let source_code = String::from_utf8(bytes).map_err(|error| format!("decode script file as utf-8: {error}"))?;

    Ok(ScriptSourceFileOutput {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("script")
            .to_string(),
        language: language.to_string(),
        path: input.path,
        source_code,
    })
}

// --- Delete rule (shared for rewrite/map) ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRuleInput {
    pub rule_id: String,
    pub rule_type: String,
}

#[tauri::command]
pub fn delete_rule(
    input: DeleteRuleInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Persist to DB first
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let db_result = match input.rule_type.as_str() {
            "rewrite" => aiproxy_db::rules::delete_rewrite_rule(&conn, &input.rule_id),
            "map" => aiproxy_db::rules::delete_map_rule(&conn, &input.rule_id),
            "dns" => aiproxy_db::rules::delete_dns_mapping(&conn, &input.rule_id),
            "script" => aiproxy_db::rules::delete_script_rule(&conn, &input.rule_id),
            _ => Err(format!("unknown rule type: {}", input.rule_type)),
        };
        db_result.map_err(|error| format!("delete rule: {error}"))?;
    }

    match input.rule_type.as_str() {
        "rewrite" => state.read_rewrite_manager().delete_rule(&input.rule_id),
        "map" => state.read_map_manager().delete_rule(&input.rule_id),
        "dns" => state.read_dns_manager().delete_rule(&input.rule_id),
        "script" => state.read_script_manager().delete_rule(&input.rule_id),
        _ => return Err(format!("unknown rule type: {}", input.rule_type)),
    }

    Ok(())
}

// --- DNS mapping commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDnsMappingsInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_dns_mappings(input: ListDnsMappingsInput, state: State<'_, Arc<AppState>>) -> Vec<DnsMappingRule> {
    let rules = state.read_dns_manager().list_rules();
    rules.into_iter().filter(|r| r.workspace_id == input.workspace_id).collect()
}

#[tauri::command]
pub fn save_dns_mapping(input: DnsMappingRule, state: State<'_, Arc<AppState>>) -> Result<DnsMappingRule, String> {
    let rule = input;

    // Persist to DB
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::DnsMappingRow {
            id: rule.id.clone(),
            workspace_id: rule.workspace_id.clone(),
            name: rule.name.clone(),
            note: rule.note.clone(),
            enabled: rule.enabled,
            priority: rule.priority,
            host_pattern: rule.host_pattern.clone(),
            target_ip: rule.target_ip.clone(),
        };
        aiproxy_db::rules::save_dns_mapping(&conn, &row)
            .map_err(|error| format!("save dns mapping: {error}"))?;
    }

    // Update in-memory manager
    state.read_dns_manager().save_rule(rule.clone());
    Ok(rule)
}

// --- Throttle commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottleProfilesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_throttle_profiles(
    input: ListThrottleProfilesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<ThrottleProfileData> {
    state.read_throttle_manager().list_profiles()
        .into_iter()
        .filter(|p| p.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_throttle_profile(
    input: ThrottleProfileData,
    state: State<'_, Arc<AppState>>,
) -> Result<ThrottleProfileData, String> {
    // Persist to DB first
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::ThrottleProfileRow {
            id: input.id.clone(),
            workspace_id: input.workspace_id.clone(),
            name: input.name.clone(),
            note: input.note.clone(),
            enabled: input.enabled,
            preset: input.preset,
            latency_ms: input.latency_ms,
            upload_kbps: input.upload_kbps,
            download_kbps: input.download_kbps,
            packet_loss_ratio: input.packet_loss_ratio,
        };
        aiproxy_db::rules::save_throttle_profile(&conn, &row)
            .map_err(|error| format!("save throttle profile: {error}"))?;
    }

    let saved = state.read_throttle_manager().save_profile(input);
    if saved.enabled {
        state
            .read_throttle_manager()
            .set_active_profile(&saved.workspace_id, Some(&saved.id));
    }

    Ok(saved)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveThrottleProfileInput {
    pub workspace_id: String,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub fn set_active_throttle_profile(
    input: SetActiveThrottleProfileInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        aiproxy_db::rules::set_active_throttle_profile(
            &conn,
            &input.workspace_id,
            input.profile_id.as_deref(),
        )
        .map_err(|error| format!("set active throttle profile: {error}"))?;
    }

    state.read_throttle_manager().set_active_profile(
        &input.workspace_id,
        input.profile_id.as_deref(),
    );

    Ok(())
}

// --- Workspace commands ---

// ---------------------------------------------------------------------------
// API Collection commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiCollectionOutput {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiCollectionItemOutput {
    pub id: String,
    pub collection_id: String,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: String,
    pub body_type: String,
    pub raw_language: String,
    pub form_data: Vec<ProxyHeaderEntry>,
    pub url_encoded: Vec<ProxyHeaderEntry>,
    pub created_at: String,
    pub updated_at: String,
}

fn parse_collection_header_entries(value: &str) -> Vec<ProxyHeaderEntry> {
    serde_json::from_str(value).unwrap_or_default()
}

fn parse_urlencoded_entries(value: &str) -> Vec<ProxyHeaderEntry> {
    form_urlencoded::parse(value.as_bytes())
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect()
}

fn collection_item_output_from_row(
    row: aiproxy_db::collections::CollectionItemRow,
) -> ApiCollectionItemOutput {
    ApiCollectionItemOutput {
        id: row.id,
        collection_id: row.collection_id,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        method: row.method,
        url: row.url,
        headers: parse_collection_header_entries(&row.headers),
        body: row.body,
        body_type: row.body_type,
        raw_language: row.raw_language,
        form_data: parse_collection_header_entries(&row.form_data),
        url_encoded: parse_collection_header_entries(&row.url_encoded),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiCollectionInput {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiCollectionItemInput {
    pub id: Option<String>,
    pub collection_id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: Option<u32>,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: String,
    pub body_type: String,
    pub raw_language: String,
    pub form_data: Vec<ProxyHeaderEntry>,
    pub url_encoded: Vec<ProxyHeaderEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiCollectionInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListApiCollectionItemsInput {
    pub collection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetApiCollectionItemInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiCollectionItemInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveApiCollectionItemInput {
    pub id: String,
    pub target_collection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionToCollectionInput {
    pub session_id: String,
    pub collection_id: String,
    pub name: Option<String>,
}

#[tauri::command]
pub fn list_api_collections(state: State<'_, Arc<AppState>>) -> Result<Vec<ApiCollectionOutput>, String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::collections::list_all_collections(&conn)
        .map_err(|error| format!("list collections: {error}"))?;
    Ok(rows.into_iter().map(|r| ApiCollectionOutput {
            id: r.id,
            parent_id: r.parent_id,
            name: r.name,
            description: r.description,
            sort_order: r.sort_order,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }).collect())
}

#[tauri::command]
pub fn upsert_api_collection(
    input: UpsertApiCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let row = aiproxy_db::collections::CollectionRow {
        id: id.clone(),
        parent_id: input.parent_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        sort_order: input.sort_order.unwrap_or(0),
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state.read_db_connection().lock().expect("db mutex");
        aiproxy_db::collections::upsert_collection(&conn, &row)
            .map_err(|e| format!("upsert collection: {e}"))?;
    }

    Ok(ApiCollectionOutput {
        id: row.id,
        parent_id: row.parent_id,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[tauri::command]
pub fn delete_api_collection(
    input: DeleteApiCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    aiproxy_db::collections::delete_collection(&conn, &input.id)
        .map_err(|e| format!("delete collection: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_api_collection_items(
    input: ListApiCollectionItemsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiCollectionItemOutput>, String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::collections::list_collection_items(&conn, &input.collection_id)
        .map_err(|error| format!("list collection items: {error}"))?;
    Ok(rows
        .into_iter()
        .map(collection_item_output_from_row)
        .collect())
}

#[tauri::command]
pub fn get_api_collection_item(
    input: GetApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    let row = aiproxy_db::collections::get_collection_item(&conn, &input.id)
        .map_err(|e| format!("get collection item: {e}"))?
        .ok_or_else(|| format!("collection item {} not found", input.id))?;

    Ok(collection_item_output_from_row(row))
}

#[tauri::command]
pub fn upsert_api_collection_item(
    input: UpsertApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let headers_json = serde_json::to_string(&input.headers).unwrap_or_else(|_| "[]".into());
    let form_data_json = serde_json::to_string(&input.form_data).unwrap_or_else(|_| "[]".into());
    let url_encoded_json = serde_json::to_string(&input.url_encoded).unwrap_or_else(|_| "[]".into());

    let row = aiproxy_db::collections::CollectionItemRow {
        id: id.clone(),
        collection_id: input.collection_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        sort_order: input.sort_order.unwrap_or(0),
        method: input.method,
        url: input.url,
        headers: headers_json,
        body: input.body,
        body_type: input.body_type,
        raw_language: input.raw_language,
        form_data: form_data_json,
        url_encoded: url_encoded_json,
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state.read_db_connection().lock().expect("db mutex");
        aiproxy_db::collections::upsert_collection_item(&conn, &row)
            .map_err(|e| format!("upsert collection item: {e}"))?;
    }

    Ok(collection_item_output_from_row(row))
}

#[tauri::command]
pub fn delete_api_collection_item(
    input: DeleteApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    aiproxy_db::collections::delete_collection_item(&conn, &input.id)
        .map_err(|e| format!("delete collection item: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn move_api_collection_item(
    input: MoveApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    aiproxy_db::collections::move_collection_item(&conn, &input.id, &input.target_collection_id)
        .map_err(|e| format!("move collection item: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn save_session_to_collection(
    input: SaveSessionToCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    // Load session summary and detail from DB
    let (method, url, headers_json, body_text) = {
        let conn = state.read_db_connection().lock().expect("db mutex");

        let summary = aiproxy_db::sessions::load_session_summary(&conn, &input.session_id)
            .map_err(|e| format!("load session summary: {e}"))?
            .ok_or_else(|| format!("session {} not found", input.session_id))?;

        let detail = aiproxy_db::sessions::load_session_detail(&conn, &input.session_id)
            .map_err(|e| format!("load session detail: {e}"))?
            .ok_or_else(|| format!("session detail {} not found", input.session_id))?;

        let body_text = detail.request_body_ref
            .and_then(|ref_json| {
                let parsed: serde_json::Value = serde_json::from_str(&ref_json).ok()?;
                parsed.get("inlineText")?.as_str().map(String::from)
            })
            .unwrap_or_default();

        (summary.method, summary.url, detail.request_headers, body_text)
    };

    // Determine body type from Content-Type header
    let headers: Vec<ProxyHeaderEntry> = serde_json::from_str(&headers_json).unwrap_or_default();
    let content_type = headers.iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.to_lowercase())
        .unwrap_or_default();

    let url_encoded = if content_type.contains("application/x-www-form-urlencoded") {
        parse_urlencoded_entries(&body_text)
    } else {
        Vec::new()
    };

    let (body_type, raw_language) = if content_type.contains("application/json") {
        ("raw".to_string(), "json".to_string())
    } else if content_type.contains("application/x-www-form-urlencoded") && !url_encoded.is_empty() {
        ("urlencoded".to_string(), "json".to_string())
    } else if !body_text.is_empty() {
        // Keep multipart or otherwise unparsed bodies visible/editable instead of
        // switching to a structured editor with empty fields.
        ("raw".to_string(), "text".to_string())
    } else {
        ("none".to_string(), "json".to_string())
    };

    let name = input.name.unwrap_or_else(|| format!("{} {}", method, url));

    let upsert_input = UpsertApiCollectionItemInput {
        id: None,
        collection_id: input.collection_id,
        name,
        description: None,
        sort_order: None,
        method,
        url,
        headers: headers.clone(),
        body: body_text,
        body_type,
        raw_language,
        form_data: vec![],
        url_encoded,
    };

    upsert_api_collection_item(upsert_input, state)
}

// ---------------------------------------------------------------------------
// API Environment commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentOutput {
    pub id: String,
    pub name: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentVariableOutput {
    pub id: String,
    pub environment_id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiEnvironmentInput {
    pub id: Option<String>,
    pub name: String,
    pub sort_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiEnvironmentInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListApiEnvironmentVariablesInput {
    pub environment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiEnvironmentVariablesInput {
    pub environment_id: String,
    pub variables: Vec<ApiEnvironmentVariableInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentVariableInput {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: Option<u32>,
}

#[tauri::command]
pub fn list_api_environments(state: State<'_, Arc<AppState>>) -> Result<Vec<ApiEnvironmentOutput>, String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::environments::list_environments(&conn)
        .map_err(|error| format!("list environments: {error}"))?;
    Ok(rows.into_iter().map(|r| ApiEnvironmentOutput {
            id: r.id,
            name: r.name,
            sort_order: r.sort_order,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }).collect())
}

#[tauri::command]
pub fn upsert_api_environment(
    input: UpsertApiEnvironmentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiEnvironmentOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let row = aiproxy_db::environments::EnvironmentRow {
        id: id.clone(),
        name: input.name,
        sort_order: input.sort_order.unwrap_or(0),
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state.read_db_connection().lock().expect("db mutex");
        aiproxy_db::environments::upsert_environment(&conn, &row)
            .map_err(|e| format!("upsert environment: {e}"))?;
    }

    Ok(ApiEnvironmentOutput {
        id: row.id,
        name: row.name,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[tauri::command]
pub fn delete_api_environment(
    input: DeleteApiEnvironmentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    aiproxy_db::environments::delete_environment(&conn, &input.id)
        .map_err(|e| format!("delete environment: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_api_environment_variables(
    input: ListApiEnvironmentVariablesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiEnvironmentVariableOutput>, String> {
    let conn = state.read_db_connection().lock().expect("db mutex");
    let rows = aiproxy_db::environments::list_environment_variables(&conn, &input.environment_id)
        .map_err(|error| format!("list environment variables: {error}"))?;
    Ok(rows.into_iter().map(|r| ApiEnvironmentVariableOutput {
            id: r.id,
            environment_id: r.environment_id,
            key: r.key,
            value: r.value,
            enabled: r.enabled,
            sort_order: r.sort_order,
        }).collect())
}

#[tauri::command]
pub fn set_api_environment_variables(
    input: SetApiEnvironmentVariablesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let vars: Vec<aiproxy_db::environments::EnvironmentVariableRow> = input.variables.into_iter().enumerate().map(|(i, v)| {
        aiproxy_db::environments::EnvironmentVariableRow {
            id: v.id,
            environment_id: input.environment_id.clone(),
            key: v.key,
            value: v.value,
            enabled: v.enabled,
            sort_order: v.sort_order.unwrap_or(i as u32),
        }
    }).collect();

    let conn = state.read_db_connection().lock().expect("db mutex");
    aiproxy_db::environments::set_environment_variables(&conn, &input.environment_id, &vars)
        .map_err(|e| format!("set environment variables: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Batch execute collection items
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExecuteInput {
    pub item_ids: Vec<String>,
    pub environment_id: Option<String>,
}

#[tauri::command]
pub async fn batch_execute_collection_items(
    input: BatchExecuteInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ProxySessionDetail>, String> {
    let items: Vec<aiproxy_db::collections::CollectionItemRow> = {
        let conn = state.read_db_connection().lock().expect("db mutex");
        let mut found = Vec::new();
        for id in &input.item_ids {
            if let Some(item) = aiproxy_db::collections::get_collection_item(&conn, id)
                .map_err(|e| format!("get item: {e}"))?
            {
                found.push(item);
            }
        }
        found
    };

    // Load environment variables if specified
    let env_vars: std::collections::HashMap<String, String> = match &input.environment_id {
        Some(env_id) => {
            let conn = state.read_db_connection().lock().expect("db mutex");
            let vars = aiproxy_db::environments::list_environment_variables(&conn, env_id)
                .map_err(|e| format!("load env vars: {e}"))?;
            vars.into_iter()
                .filter(|v| v.enabled)
                .map(|v| (v.key, v.value))
                .collect()
        }
        None => std::collections::HashMap::new(),
    };

    let mut results = Vec::new();
    for item in items {
        let url = substitute_vars(&item.url, &env_vars);
        let headers_str = substitute_vars(&item.headers, &env_vars);
        let body = substitute_vars(&item.body, &env_vars);

        let headers: Vec<ProxyHeaderEntry> = serde_json::from_str(&headers_str).unwrap_or_default();

        match send_direct_request(item.method, url, headers, Some(body)).await {
            Ok(detail) => {
                let session_id = detail.id.clone();
                state.upsert_session(detail.clone());
                log_debug(
                    "desktop.commands",
                    "batch_execute_item_succeeded",
                    &[("session_id", session_id)],
                );
                results.push(detail);
            }
            Err(e) => {
                log_error(
                    "desktop.commands",
                    "batch_execute_item_failed",
                    &[("item_id", item.id), ("error", e.clone())],
                );
                return Err(format!("batch execute failed at item '{}': {}", item.name, e));
            }
        }
    }

    Ok(results)
}

fn substitute_vars(template: &str, vars: &std::collections::HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in vars {
        let pattern = format!("{{{{{}}}}}", key);
        result = result.replace(&pattern, value);
    }
    result
}

fn next_available_export_path(downloads_dir: &Path, file_name: &str) -> PathBuf {
    let requested_path = downloads_dir.join(file_name);

    if !requested_path.exists() {
        return requested_path;
    }

    let stem = requested_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let extension = requested_path.extension().and_then(|value| value.to_str());

    for index in 1..10_000 {
        let candidate_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate_path = downloads_dir.join(candidate_name);

        if !candidate_path.exists() {
            return candidate_path;
        }
    }

    requested_path
}

#[tauri::command]
pub fn list_workspaces(state: State<'_, Arc<AppState>>) -> Vec<WorkspaceData> {
    state.read_workspace_manager().list()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub name: String,
    pub proxy_port: u16,
    pub ssl_enabled: Option<bool>,
}

#[tauri::command]
pub fn create_workspace(
    input: CreateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> WorkspaceData {
    let ssl_enabled = input.ssl_enabled.unwrap_or(true);

    log_info(
        "desktop.commands",
        "create_workspace_requested",
        &[
            ("name", input.name.clone()),
            ("port", input.proxy_port.to_string()),
            ("ssl_enabled", ssl_enabled.to_string()),
        ],
    );

    let workspace = state
        .read_workspace_manager()
        .create(input.name, input.proxy_port, ssl_enabled);

    // Persist to DB
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::workspaces::WorkspaceRow {
            id: workspace.id.clone(),
            name: workspace.name.clone(),
            proxy_port: workspace.proxy_port,
            ssl_enabled: workspace.ssl_enabled,
            system_proxy_enabled: workspace.system_proxy_enabled,
            storage_path: workspace.storage_path.clone(),
            created_at: workspace.created_at.clone(),
            updated_at: workspace.updated_at.clone(),
        };
        if let Err(error) = aiproxy_db::workspaces::upsert_workspace(&conn, &row) {
            log_error("desktop.commands", "create_workspace_db_failed", &[("error", error)]);
        }
    }

    log_info(
        "desktop.commands",
        "create_workspace_succeeded",
        &[("workspace_id", workspace.id.clone())],
    );

    workspace
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn load_workspace(
    input: LoadWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    log_info(
        "desktop.commands",
        "load_workspace_requested",
        &[("workspace_id", input.workspace_id.clone())],
    );

    let workspace = state
        .read_workspace_manager()
        .load(&input.workspace_id)
        .ok_or_else(|| format!("workspace {} not found", input.workspace_id))?;

    log_info(
        "desktop.commands",
        "load_workspace_succeeded",
        &[
            ("workspace_id", workspace.id.clone()),
            ("name", workspace.name.clone()),
        ],
    );

    Ok(workspace)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub workspace_id: String,
    pub name: Option<String>,
    pub proxy_port: Option<u16>,
    pub ssl_enabled: Option<bool>,
}

#[tauri::command]
pub fn update_workspace(
    input: UpdateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    log_info(
        "desktop.commands",
        "update_workspace_requested",
        &[("workspace_id", input.workspace_id.clone())],
    );

    let workspace = state.read_workspace_manager().update(
        &input.workspace_id,
        input.name.clone(),
        input.proxy_port,
        input.ssl_enabled,
    )?;

    // Persist to DB
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            &workspace.updated_at,
        ) {
            log_error("desktop.commands", "update_workspace_db_failed", &[("error", error)]);
        }
    }

    log_info(
        "desktop.commands",
        "update_workspace_succeeded",
        &[("workspace_id", workspace.id.clone())],
    );

    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::{
        collection_item_output_from_row, parse_collection_header_entries,
        parse_urlencoded_entries,
    };
    use aiproxy_db::collections::CollectionItemRow;

    #[test]
    fn collection_item_output_decodes_json_fields() {
        let output = collection_item_output_from_row(CollectionItemRow {
            id: "item-1".into(),
            collection_id: "collection-1".into(),
            name: "Create Order".into(),
            description: String::new(),
            sort_order: 0,
            method: "POST".into(),
            url: "https://api.example.com/orders".into(),
            headers: r#"[{"name":"Content-Type","value":"application/json"}]"#.into(),
            body: "{\"ok\":true}".into(),
            body_type: "raw".into(),
            raw_language: "json".into(),
            form_data: r#"[{"name":"file","value":"demo.txt"}]"#.into(),
            url_encoded: r#"[{"name":"page","value":"1"}]"#.into(),
            created_at: "2026-04-20T00:00:00Z".into(),
            updated_at: "2026-04-20T00:00:00Z".into(),
        });

        assert_eq!(output.headers.len(), 1);
        assert_eq!(output.headers[0].name, "Content-Type");
        assert_eq!(output.form_data[0].name, "file");
        assert_eq!(output.url_encoded[0].value, "1");
    }

    #[test]
    fn invalid_collection_json_falls_back_to_empty_entries() {
        assert!(parse_collection_header_entries("{invalid json]").is_empty());
    }

    #[test]
    fn urlencoded_body_is_decoded_into_entries() {
        let entries = parse_urlencoded_entries("name=alice+smith&city=New%20York");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "name");
        assert_eq!(entries[0].value, "alice smith");
        assert_eq!(entries[1].name, "city");
        assert_eq!(entries[1].value, "New York");
    }
}
