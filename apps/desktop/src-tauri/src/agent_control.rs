use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use aiproxy_agent_control::{
    read_json_line, remove_descriptor, token_matches, write_descriptor, write_json_line,
    ConfigureWorkspaceParams, ControlDescriptor, ControlError, ControlOperation, ControlPermission,
    ControlRequest, ControlResponse, DiagnosticLogLevel, ReadDiagnosticLogsParams,
    CONTROL_MAX_REQUEST_BYTES, CONTROL_MAX_RESPONSE_BYTES, CONTROL_PROTOCOL_VERSION,
    DIAGNOSTIC_AUDIT_MAX_ENTRIES, DIAGNOSTIC_LOG_MAX_BYTES, DIAGNOSTIC_LOG_MAX_LINES,
};
use aiproxy_mcp::audit::{AuditEntry, AuditLog};
use aiproxy_mcp::config::{read_config, AgentAccessConfig};
use interprocess::local_socket::{prelude::*, ListenerOptions};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::bootstrap::AppState;
use crate::commands::{
    disable_system_proxy_impl, enable_system_proxy_impl, generate_root_certificate_impl,
    get_certificate_status_impl, launch_certificate_installer_impl,
    open_certificate_install_guide_impl, remove_certificate_trust_impl, start_proxy_impl,
    stop_proxy_impl, update_workspace_impl, GenerateRootCertificateInput, StartProxyInput,
    StopProxyInput, UpdateWorkspaceInput,
};

static SERVER: OnceLock<Mutex<Option<ControlServerState>>> = OnceLock::new();
static RECENT_CONTROL_ACTIONS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
const MAX_RECENT_CONTROL_ACTIONS: usize = 20;
const CONTROL_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONCURRENT_CONTROL_CONNECTIONS: usize = 16;

#[derive(Debug)]
struct ControlServerState {
    data_dir: PathBuf,
    socket_path: Option<PathBuf>,
}

struct ControlConnectionPermit(Arc<AtomicUsize>);

impl Drop for ControlConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_connection_permit(
    active: &Arc<AtomicUsize>,
    limit: usize,
) -> Option<ControlConnectionPermit> {
    if active.fetch_add(1, Ordering::AcqRel) >= limit {
        active.fetch_sub(1, Ordering::AcqRel);
        return None;
    }
    Some(ControlConnectionPermit(Arc::clone(active)))
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let data_dir = aiproxy_db::connection::resolve_db_dir()
        .map_err(|error| format!("resolve AIProxy data directory: {error}"))?;
    remove_descriptor(&data_dir);
    let endpoint = control_endpoint(&data_dir);
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    #[cfg(unix)]
    let socket_path = Some(PathBuf::from(&endpoint));
    #[cfg(not(unix))]
    let socket_path = None;
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&endpoint);
    }

    #[cfg(unix)]
    let name = endpoint
        .as_str()
        .to_fs_name::<interprocess::local_socket::GenericFilePath>()
        .map_err(|error| format!("create AIProxy control socket name: {error}"))?;
    #[cfg(windows)]
    let name = endpoint
        .as_str()
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()
        .map_err(|error| format!("create AIProxy control pipe name: {error}"))?;

    let listener_options = ListenerOptions::new().name(name).reclaim_name(true);
    #[cfg(windows)]
    let listener_options = {
        use interprocess::os::windows::{
            local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
        };
        use widestring::U16CString;

        // A protected DACL that grants access only to the pipe object's owner
        // (OW). Windows sets the owner to the user that created the pipe.
        let sddl = U16CString::from_str("D:P(A;;GA;;;OW)")
            .map_err(|error| format!("create AIProxy control pipe ACL: {error}"))?;
        let descriptor = SecurityDescriptor::deserialize(&sddl)
            .map_err(|error| format!("parse AIProxy control pipe ACL: {error}"))?;
        listener_options.security_descriptor(descriptor)
    };
    let listener = listener_options
        .create_sync()
        .map_err(|error| format!("start AIProxy Agent control listener: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("restrict AIProxy control socket permissions: {error}"))?;
    }

    let descriptor = ControlDescriptor {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        endpoint: endpoint.clone(),
        token: token.clone(),
        pid: std::process::id(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    write_descriptor(&data_dir, &descriptor)?;

    let slot = SERVER.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    if guard.is_some() {
        remove_descriptor(&data_dir);
        return Err("AIProxy Agent control server is already running".to_string());
    }
    *guard = Some(ControlServerState {
        data_dir: data_dir.clone(),
        socket_path,
    });
    drop(guard);

    let app = app.clone();
    let write_lock = Arc::new(tokio::sync::Mutex::new(()));
    let active_connections = Arc::new(AtomicUsize::new(0));
    if let Err(error) = std::thread::Builder::new()
        .name("agent-control-listener".to_string())
        .spawn(move || loop {
            match listener.accept() {
                Ok(connection) => {
                    let Some(permit) = acquire_connection_permit(
                        &active_connections,
                        MAX_CONCURRENT_CONTROL_CONNECTIONS,
                    ) else {
                        tracing::warn!(
                            component = "desktop.agent_control",
                            event = "control_connection_rejected",
                            limit = MAX_CONCURRENT_CONTROL_CONNECTIONS,
                            "control_connection_rejected"
                        );
                        continue;
                    };
                    if let Err(error) = connection
                        .set_recv_timeout(Some(CONTROL_REQUEST_READ_TIMEOUT))
                        .and_then(|()| {
                            connection.set_send_timeout(Some(CONTROL_REQUEST_READ_TIMEOUT))
                        })
                    {
                        tracing::warn!(
                            component = "desktop.agent_control",
                            event = "control_connection_timeout_failed",
                            error = %error,
                            "control_connection_timeout_failed"
                        );
                        continue;
                    }
                    let app = app.clone();
                    let token = token.clone();
                    let data_dir = data_dir.clone();
                    let write_lock = Arc::clone(&write_lock);
                    if let Err(error) = std::thread::Builder::new()
                        .name("agent-control-request".to_string())
                        .spawn(move || {
                            let _permit = permit;
                            handle_connection(app, connection, token, data_dir, write_lock)
                        })
                    {
                        tracing::error!(
                            component = "desktop.agent_control",
                            event = "control_request_thread_failed",
                            error = %error,
                            "control_request_thread_failed"
                        );
                    }
                }
                Err(error) => {
                    tracing::error!(
                        component = "desktop.agent_control",
                        event = "control_accept_failed",
                        error = %error,
                        "control_accept_failed"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        })
    {
        // Do not leave a descriptor or socket behind when the accept loop
        // could not be started; the sidecar would otherwise see a channel
        // that can never answer.
        shutdown();
        return Err(format!("spawn AIProxy control listener: {error}"));
    }

    tracing::info!(
        component = "desktop.agent_control",
        event = "control_server_started",
        protocol_version = CONTROL_PROTOCOL_VERSION,
        endpoint = %endpoint,
        "control_server_started"
    );
    Ok(())
}

pub fn shutdown() {
    let Some(slot) = SERVER.get() else {
        return;
    };
    let state = slot
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(state) = state {
        remove_descriptor(&state.data_dir);
        #[cfg(unix)]
        if let Some(path) = state.socket_path {
            let _ = std::fs::remove_file(path);
        }
        tracing::info!(
            component = "desktop.agent_control",
            event = "control_server_stopped",
            "control_server_stopped"
        );
    }
}

fn handle_connection(
    app: AppHandle,
    connection: interprocess::local_socket::Stream,
    token: String,
    data_dir: PathBuf,
    write_lock: Arc<tokio::sync::Mutex<()>>,
) {
    let mut reader = BufReader::new(&connection);
    let request_bytes = match read_json_line(&mut reader, CONTROL_MAX_REQUEST_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            let response = ControlResponse::failure(
                String::new(),
                ControlError::new(
                    "INVALID_ARGUMENT",
                    format!("Read AIProxy control request: {error}"),
                ),
            );
            let _ = write_json_line(&mut &connection, &response);
            return;
        }
    };
    drop(reader);

    let request = match parse_control_request(&request_bytes) {
        Ok(request) => request,
        Err(error) => {
            let response = ControlResponse::failure(String::new(), error);
            let _ = write_json_line(&mut &connection, &response);
            return;
        }
    };
    let request_id = request.request_id.clone();
    let action_summary = request.operation.action_summary();
    let audit_tool = request.operation.audit_tool_name();
    let method = request.operation.method_name();
    let is_write = request.operation.is_write();
    let client_name = audit_identity(request.client_name.as_deref());
    let client_version = audit_identity(request.client_version.as_deref());

    let started = Instant::now();
    let execution = execute_request(&app, &token, &data_dir, request, &write_lock);
    let mut response = match execution.result {
        Ok(data) => ControlResponse::success(request_id, data),
        Err(error) => ControlResponse::failure(request_id, error),
    };
    if is_write {
        if let Err(error) = append_control_audit(
            &data_dir,
            &client_name,
            &client_version,
            audit_tool,
            &action_summary,
            started,
            &response,
        ) {
            tracing::error!(
                component = "desktop.agent_control",
                event = "control_audit_write_failed",
                method,
                error = %error,
                "control_audit_write_failed"
            );
            // Preflight should make this rare. If the action already ran, tell
            // the Agent not to retry blindly rather than returning a false
            // success without an audit trail.
            if response.ok {
                response = ControlResponse::failure(
                    response.request_id,
                    ControlError::new(
                        "AUDIT_UNAVAILABLE",
                        "The action completed, but its Agent audit entry could not be written. Check AIProxy state before retrying a non-idempotent action, and fix the data-directory permissions.",
                    ),
                );
            }
        }
    }
    let response = cap_response_size(response);
    let _ = write_json_line(&mut &connection, &response);

    if is_write && execution.notify_ui {
        let action_event = json!({
            "eventId": uuid::Uuid::new_v4().to_string(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "method": method,
            "actionSummary": action_summary,
            "ok": response.ok,
            "errorCode": response.error.as_ref().map(|error| error.code.clone()),
            "durationMs": started.elapsed().as_millis() as u64,
        });
        remember_control_action(&action_event);
        let _ = app.emit("agent-control-action", action_event);
    }
    tracing::info!(
        component = "desktop.agent_control",
        event = "control_request_finished",
        method,
        action_summary = %action_summary,
        success = response.ok,
        duration_ms = started.elapsed().as_millis() as u64,
        "control_request_finished"
    );
}

fn audit_identity(value: Option<&str>) -> String {
    value
        .unwrap_or("unknown")
        .chars()
        .take(128)
        .collect::<String>()
}

fn append_control_audit(
    data_dir: &Path,
    client_name: &str,
    client_version: &str,
    tool: &str,
    action_summary: &str,
    started: Instant,
    response: &ControlResponse,
) -> Result<(), std::io::Error> {
    let returned_bytes = response
        .data
        .as_ref()
        .and_then(|data| serde_json::to_vec(data).ok())
        .map(|bytes| bytes.len());
    AuditLog::new(data_dir.join("agent-audit.jsonl")).append(&AuditEntry {
        timestamp: chrono::Utc::now().to_rfc3339(),
        client_name,
        client_version,
        tool,
        action_summary: Some(action_summary.to_string()),
        agent_control: true,
        outcome: if response.ok { "success" } else { "error" },
        duration_ms: started.elapsed().as_millis() as u64,
        returned_bytes,
        redacted: true,
        truncated: false,
        error_code: response.error.as_ref().map(|error| error.code.as_str()),
    })
}

struct ControlExecution {
    result: Result<Value, ControlError>,
    notify_ui: bool,
}

fn remember_control_action(event: &Value) {
    let mut actions = RECENT_CONTROL_ACTIONS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    actions.push_back(event.clone());
    while actions.len() > MAX_RECENT_CONTROL_ACTIONS {
        actions.pop_front();
    }
}

/// Return a bounded replay buffer for the renderer. The first Agent action can
/// finish before React has mounted its event listener when AIProxy was launched
/// on demand, so state refresh and the action notification would otherwise be
/// invisible. The renderer deduplicates by `eventId` against live events.
#[tauri::command]
pub fn get_recent_agent_control_actions() -> Vec<Value> {
    RECENT_CONTROL_ACTIONS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .cloned()
        .collect()
}

fn cap_response_size(response: ControlResponse) -> ControlResponse {
    match serde_json::to_vec(&response) {
        Ok(bytes) if bytes.len() <= CONTROL_MAX_RESPONSE_BYTES => response,
        _ => ControlResponse::failure(
            response.request_id,
            ControlError::new(
                "RESULT_TOO_LARGE",
                "The AIProxy control response exceeds the configured size limit. Narrow the request and retry.",
            ),
        ),
    }
}

fn parse_control_request(bytes: &[u8]) -> Result<ControlRequest, ControlError> {
    match serde_json::from_slice::<ControlRequest>(bytes) {
        Ok(request) => Ok(request),
        Err(error) => Err(control_request_parse_error(error)),
    }
}

fn control_request_parse_error(error: serde_json::Error) -> ControlError {
    if error.to_string().contains("unknown variant `") {
        ControlError::new(
            "CONTROL_UNAVAILABLE",
            "This AIProxy build does not support the requested Agent control operation. Update AIProxy and the MCP sidecar together, restart the app, then retry.",
        )
    } else {
        ControlError::new(
            "INVALID_ARGUMENT",
            format!("Parse AIProxy control request: {error}"),
        )
    }
}

fn execute_request(
    app: &AppHandle,
    token: &str,
    data_dir: &Path,
    request: ControlRequest,
    write_lock: &Arc<tokio::sync::Mutex<()>>,
) -> ControlExecution {
    if let Err(error) = preflight_request(token, data_dir, &request) {
        return ControlExecution {
            result: Err(error),
            notify_ui: false,
        };
    }

    let result = if request.operation.is_write() {
        let created_by = audit_identity(request.client_name.as_deref());
        let guard = tauri::async_runtime::block_on(write_lock.lock());
        // A request can wait behind another long write. Re-read the live
        // permissions and audit availability after acquiring the lock so a
        // revocation that happened while queued still stops this action.
        let result = match preflight_request(token, data_dir, &request) {
            Ok(()) => {
                let state = Arc::clone(app.state::<Arc<AppState>>().inner());
                tauri::async_runtime::block_on(dispatch(
                    state,
                    data_dir.to_path_buf(),
                    request.operation,
                    &created_by,
                ))
            }
            Err(error) => Err(error),
        };
        drop(guard);
        result
    } else {
        let created_by = audit_identity(request.client_name.as_deref());
        let state = Arc::clone(app.state::<Arc<AppState>>().inner());
        tauri::async_runtime::block_on(dispatch(
            state,
            data_dir.to_path_buf(),
            request.operation,
            &created_by,
        ))
    };
    ControlExecution {
        result,
        notify_ui: true,
    }
}

/// Validate everything that can deny a control action before any side effect
/// runs. Keeping this separate from `dispatch` makes the security boundary
/// testable without constructing a Tauri application.
fn preflight_request(
    token: &str,
    data_dir: &Path,
    request: &ControlRequest,
) -> Result<(), ControlError> {
    if request.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(ControlError::new(
            "CONTROL_UNAVAILABLE",
            format!(
                "Unsupported Agent control protocol version {}. This AIProxy build supports version {CONTROL_PROTOCOL_VERSION}; update the desktop app and MCP sidecar together.",
                request.protocol_version
            ),
        ));
    }
    if request.request_id.trim().is_empty() || request.request_id.len() > 128 {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "Control requestId must be 1-128 bytes.",
        ));
    }
    if !token_matches(token, &request.token) {
        return Err(ControlError::new(
            "CONTROL_PERMISSION_DENIED",
            "The AIProxy control token is invalid. Restart AIProxy and retry.",
        ));
    }

    let config_path = data_dir.join("agent-access.json");
    let config = read_config(&config_path).map_err(|error| {
        ControlError::new(
            "CONTROL_PERMISSION_DENIED",
            format!("Agent Access is not available: {}", error.message()),
        )
    })?;
    if !config.enabled {
        return Err(ControlError::new(
            "CONTROL_PERMISSION_DENIED",
            "Agent Access is disabled. Enable it in AIProxy Settings > Agent Access.",
        ));
    }
    ensure_permission(&config, &request.operation)?;
    validate_operation(&request.operation)?;

    if request.operation.is_write() {
        let audit = AuditLog::new(data_dir.join("agent-audit.jsonl"));
        audit.check_writable().map_err(|error| {
            ControlError::new(
                "AUDIT_UNAVAILABLE",
                format!(
                    "The Agent audit log is not writable, so the control action was not executed: {error}"
                ),
            )
        })?;
    }
    Ok(())
}

async fn dispatch(
    state: Arc<AppState>,
    data_dir: PathBuf,
    operation: ControlOperation,
    created_by: &str,
) -> Result<Value, ControlError> {
    match operation {
        ControlOperation::GetStatus => get_status(state).await,
        ControlOperation::ReadDiagnosticLogs(params) => read_diagnostic_logs(&data_dir, params),
        ControlOperation::ConfigureWorkspace(params) => configure_workspace(state, params).await,
        ControlOperation::StartCapture(params) => start_capture(state, params.workspace_id).await,
        ControlOperation::StopCapture(params) => stop_capture(state, params.workspace_id).await,
        ControlOperation::SetSystemProxy(params) => set_system_proxy(state, params.enabled).await,
        ControlOperation::GenerateCertificate(params) => {
            let status = generate_root_certificate_impl(
                GenerateRootCertificateInput {
                    force_regenerate: Some(params.force_regenerate),
                },
                Arc::clone(&state),
            )
            .await
            .map_err(control_error)?;
            Ok(json!({
                "status": status,
                "userActionRequired": !status.trusted,
                "nextStep": if status.trusted {
                    "Certificate is trusted. SSL capture can be enabled."
                } else {
                    "Call open_certificate_installer and have the user complete the platform certificate-trust prompt."
                }
            }))
        }
        ControlOperation::OpenCertificateInstaller => {
            let guide_state = Arc::clone(&state);
            let guide = tauri::async_runtime::spawn_blocking(move || {
                open_certificate_install_guide_impl(guide_state)
            })
            .await
            .map_err(|error| {
                ControlError::new("INTERNAL_ERROR", format!("certificate guide task: {error}"))
            })?
            .map_err(control_error)?;
            let launch_state = Arc::clone(&state);
            tauri::async_runtime::spawn_blocking(move || {
                launch_certificate_installer_impl(launch_state)
            })
            .await
            .map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("certificate installer task: {error}"),
                )
            })?
            .map_err(control_error)?;
            Ok(json!({
                "opened": true,
                "userActionRequired": true,
                "platform": guide.get("platform").cloned().unwrap_or(Value::Null),
                "certPath": guide.get("certPath").cloned().unwrap_or(Value::Null),
                "steps": guide.get("steps").cloned().unwrap_or_else(|| json!([])),
            }))
        }
        ControlOperation::RemoveCertificateTrust => {
            let output = remove_certificate_trust_impl(Arc::clone(&state))
                .await
                .map_err(control_error)?;
            Ok(serde_json::to_value(output).map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("serialize certificate removal result: {error}"),
                )
            })?)
        }
        ControlOperation::ClearSessions => {
            let result = state.clear_sessions().await.map_err(control_error)?;
            Ok(serde_json::to_value(result).map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("serialize clear sessions result: {error}"),
                )
            })?)
        }
        ControlOperation::DeleteSessions(params) => {
            let result = state
                .delete_sessions(params.session_ids)
                .await
                .map_err(control_error)?;
            Ok(serde_json::to_value(result).map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("serialize delete sessions result: {error}"),
                )
            })?)
        }
        ControlOperation::ReplaySession(params) => {
            let result = crate::agent_replay::replay_session(Arc::clone(&state), params).await?;
            serde_json::to_value(result).map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("serialize replay result: {error}"),
                )
            })
        }
        ControlOperation::CreateAgentRule(params) => {
            let workspace_id = state
                .read_status()
                .active_workspace_id
                .unwrap_or_else(|| "default".to_string());
            let info = state
                .read_agent_rule_registry()
                .create(params, &workspace_id, created_by)
                .map_err(agent_rule_control_error)?;
            serde_json::to_value(info).map_err(|error| {
                ControlError::new("INTERNAL_ERROR", format!("serialize Agent rule: {error}"))
            })
        }
        ControlOperation::ListAgentRules => {
            let rules = state.read_agent_rule_registry().list();
            serde_json::to_value(rules).map_err(|error| {
                ControlError::new("INTERNAL_ERROR", format!("serialize Agent rules: {error}"))
            })
        }
        ControlOperation::RemoveAgentRules(params) => {
            let result = state.read_agent_rule_registry().remove(params.rule_ids);
            serde_json::to_value(result).map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("serialize Agent rule removal: {error}"),
                )
            })
        }
    }
}

fn agent_rule_control_error(error: crate::agent_rules::AgentRuleError) -> ControlError {
    ControlError::new(error.code, error.message)
}

#[tauri::command]
pub fn clear_agent_rules(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    let result = state.read_agent_rule_registry().clear();
    serde_json::to_value(result).map_err(|error| format!("serialize Agent rule cleanup: {error}"))
}

fn read_diagnostic_logs(
    data_dir: &Path,
    params: ReadDiagnosticLogsParams,
) -> Result<Value, ControlError> {
    let query = params
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if query.is_some_and(|value| value.chars().count() > 128 || value.chars().any(char::is_control))
    {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "diagnostic query must be at most 128 characters and contain no control characters",
        ));
    }
    if params.max_lines == 0 || params.max_lines > DIAGNOSTIC_LOG_MAX_LINES {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!("diagnostic maxLines must be between 1 and {DIAGNOSTIC_LOG_MAX_LINES}."),
        ));
    }
    let max_lines = params.max_lines;
    let level = params.level.unwrap_or(DiagnosticLogLevel::Any);
    let app_logs = if params.include_app_log {
        read_app_log_evidence(query, level, max_lines)?
    } else {
        Vec::new()
    };
    let (audit_entries, audit_truncated) = if params.include_audit_log {
        read_audit_evidence(data_dir, query, max_lines)?
    } else {
        (Vec::new(), false)
    };
    Ok(json!({
        "available": true,
        "appLog": {
            "query": query,
            "level": serde_json::to_value(level).unwrap_or(Value::Null),
            "maxLines": max_lines,
            "files": app_logs,
        },
        "auditLog": {
            "query": query,
            "maxEntries": DIAGNOSTIC_AUDIT_MAX_ENTRIES,
            "truncated": audit_truncated,
            "entries": audit_entries,
        },
        "limits": {
            "maxLines": DIAGNOSTIC_LOG_MAX_LINES,
            "maxBytes": DIAGNOSTIC_LOG_MAX_BYTES,
            "maxAuditEntries": DIAGNOSTIC_AUDIT_MAX_ENTRIES,
        }
    }))
}

#[derive(Default)]
struct DiagnosticFileEvidence {
    path: String,
    matched_lines: usize,
    truncated: bool,
    lines: Vec<String>,
}

fn read_app_log_evidence(
    query: Option<&str>,
    level: DiagnosticLogLevel,
    max_lines: usize,
) -> Result<Vec<Value>, ControlError> {
    let mut remaining_lines = max_lines;
    let mut remaining_bytes = DIAGNOSTIC_LOG_MAX_BYTES;
    let mut evidence = Vec::new();
    for path in crate::dev_logger::diagnostic_log_files() {
        let mut file_evidence = DiagnosticFileEvidence {
            path: path.display().to_string(),
            ..DiagnosticFileEvidence::default()
        };
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ControlError::new(
                    "LOG_UNAVAILABLE",
                    format!("read AIProxy log {}: {error}", path.display()),
                ))
            }
        };
        let reader = BufReader::new(file);
        let mut selected = VecDeque::new();
        for line in reader.lines() {
            let line = line.map_err(|error| {
                ControlError::new(
                    "LOG_UNAVAILABLE",
                    format!("read AIProxy log {}: {error}", path.display()),
                )
            })?;
            if !line_matches_query(&line, query) || !line_matches_level(&line, level) {
                continue;
            }
            file_evidence.matched_lines += 1;
            if selected.len() >= max_lines {
                file_evidence.truncated = true;
                selected.pop_front();
            }
            selected.push_back(line);
        }
        // Keep the newest matches first while preserving each file's order.
        let selected = selected.into_iter().rev().collect::<Vec<_>>();
        for line in selected {
            let line_bytes = line.len();
            if remaining_lines == 0 || line_bytes > remaining_bytes {
                file_evidence.truncated = true;
                break;
            }
            file_evidence.lines.push(line);
            remaining_lines -= 1;
            remaining_bytes -= line_bytes;
        }
        if !file_evidence.lines.is_empty() {
            evidence.push(json!({
                "path": file_evidence.path,
                "matchedLines": file_evidence.matched_lines,
                "returnedLines": file_evidence.lines.len(),
                "truncated": file_evidence.truncated,
                "lines": file_evidence.lines,
            }));
        }
        if remaining_lines == 0 || remaining_bytes == 0 {
            break;
        }
    }
    Ok(evidence)
}

fn read_audit_evidence(
    data_dir: &Path,
    query: Option<&str>,
    max_lines: usize,
) -> Result<(Vec<Value>, bool), ControlError> {
    let path = data_dir.join("agent-audit.jsonl");
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false))
        }
        Err(error) => {
            return Err(ControlError::new(
                "LOG_UNAVAILABLE",
                format!("read Agent audit log {}: {error}", path.display()),
            ))
        }
    };
    let max_entries = max_lines
        .saturating_mul(2)
        .clamp(1, DIAGNOSTIC_AUDIT_MAX_ENTRIES);
    let reader = BufReader::new(file);
    let mut entries = VecDeque::new();
    let mut matched_entries = 0usize;
    for line in reader.lines() {
        let line = line.map_err(|error| {
            ControlError::new(
                "LOG_UNAVAILABLE",
                format!("read Agent audit log {}: {error}", path.display()),
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        if !line_matches_query(&line, query) {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        matched_entries += 1;
        if entries.len() == max_entries {
            entries.pop_front();
        }
        entries.push_back(entry);
    }
    let truncated = matched_entries > max_entries;
    Ok((entries.into_iter().rev().collect(), truncated))
}

fn line_matches_query(line: &str, query: Option<&str>) -> bool {
    let Some(query) = query else {
        return true;
    };
    line.to_lowercase().contains(&query.to_lowercase())
}

fn line_matches_level(line: &str, level: DiagnosticLogLevel) -> bool {
    match level {
        DiagnosticLogLevel::Any => true,
        DiagnosticLogLevel::Error => line_has_level(line, "ERROR") || line_has_panic_event(line),
        DiagnosticLogLevel::Warning => {
            line_has_level(line, "WARN")
                || line_has_level(line, "ERROR")
                || line_has_panic_event(line)
        }
    }
}

fn line_has_panic_event(line: &str) -> bool {
    line.contains("event=\"panic\"") || line.contains("event=panic")
}

fn line_has_level(line: &str, level: &str) -> bool {
    let upper = line.to_ascii_uppercase();
    upper.starts_with(level)
        || upper.contains(&format!(" {level} "))
        || upper.ends_with(&format!(" {level}"))
}

async fn get_status(state: Arc<AppState>) -> Result<Value, ControlError> {
    let status = state.read_status();
    let workspaces = state
        .read_workspace_manager()
        .list()
        .iter()
        .map(|workspace| {
            let runtime_status = if status.active_workspace_id.as_deref() == Some(&workspace.id) {
                if status.running {
                    "running"
                } else {
                    "stopped"
                }
            } else {
                "unknown"
            };
            workspace_status_json(workspace, runtime_status)
        })
        .collect::<Vec<_>>();
    let cert_state = Arc::clone(&state);
    let certificate =
        tauri::async_runtime::spawn_blocking(move || get_certificate_status_impl(cert_state))
            .await
            .map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("certificate status task: {error}"),
                )
            })?
            .map_err(control_error)?;
    Ok(json!({
        "appRunning": true,
        "controlAvailable": true,
        "protocolVersion": CONTROL_PROTOCOL_VERSION,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "capture": {
            "status": if status.running { "running" } else { "stopped" },
            "running": status.running,
            "port": status.port,
            "sslEnabled": status.ssl_enabled,
            "http2Enabled": status.http2_enabled,
            "startedAt": status.started_at,
        },
        "activeWorkspaceId": status.active_workspace_id,
        "workspaces": workspaces,
        "certificate": certificate,
        "systemProxy": {
            "known": true,
            "enabled": status.system_proxy_enabled,
        },
        "systemProxyRecoveryWarning": status.system_proxy_recovery_warning,
        "nextSteps": next_steps(&status, &certificate),
    }))
}

fn next_steps(
    status: &crate::bootstrap::BootstrapStatus,
    certificate: &crate::bootstrap::CertificateStateSnapshot,
) -> Vec<&'static str> {
    let mut steps = Vec::new();
    if certificate.cert_path.is_none() {
        steps.push("Generate a root certificate.");
    }
    if certificate.cert_path.is_some() && !certificate.trusted {
        steps.push("Open the certificate installer and complete platform trust.");
    }
    if !status.running {
        steps.push("Start capture using the saved workspace configuration.");
    } else if status.ssl_enabled && !certificate.trusted {
        steps.push("HTTPS clients will reject interception until the root certificate is trusted.");
    }
    if status.running && !status.system_proxy_enabled {
        steps.push("Optionally enable the system proxy after certificate trust is verified.");
    }
    steps
}

async fn configure_workspace(
    state: Arc<AppState>,
    params: ConfigureWorkspaceParams,
) -> Result<Value, ControlError> {
    let status = state.read_status();
    let workspace_id = params
        .workspace_id
        .or_else(|| status.active_workspace_id.clone())
        .unwrap_or_else(|| "default".to_string());
    if state.read_workspace_manager().load(&workspace_id).is_none() {
        return Err(ControlError::new(
            "WORKSPACE_NOT_FOUND",
            format!("Workspace not found: {workspace_id}"),
        ));
    }
    let workspace = update_workspace_impl(
        UpdateWorkspaceInput {
            workspace_id: workspace_id.clone(),
            name: None,
            proxy_port: params.proxy_port,
            ssl_enabled: params.ssl_enabled,
            http2_enabled: params.http2_enabled,
            verify_upstream_tls: None,
            tls_verify_hosts: None,
            ssl_blind_hosts: params.ssl_blind_hosts,
            upstream_proxy: None,
            ssl_proxying: params.ssl_proxying.map(|settings| {
                aiproxy_proxy_core::SslProxyingSettings {
                    include_enabled: settings.include_enabled,
                    exclude_enabled: settings.exclude_enabled,
                    include: settings
                        .include
                        .into_iter()
                        .map(|entry| aiproxy_proxy_core::SslProxyEntry {
                            pattern: entry.pattern,
                            enabled: entry.enabled,
                        })
                        .collect(),
                    exclude: settings
                        .exclude
                        .into_iter()
                        .map(|entry| aiproxy_proxy_core::SslProxyEntry {
                            pattern: entry.pattern,
                            enabled: entry.enabled,
                        })
                        .collect(),
                }
            }),
        },
        Arc::clone(&state),
    )
    .await
    .map_err(control_error)?;

    let apply_now = params.apply_now.unwrap_or(true);
    let should_restart = apply_now
        && status.running
        && status.active_workspace_id.as_deref() == Some(workspace_id.as_str());
    if !should_restart {
        let warning = if !apply_now {
            "The workspace configuration was saved. applyNow=false, so the running proxy was left unchanged."
        } else if status.running {
            "The running proxy belongs to a different workspace; the saved settings apply on its next start."
        } else {
            "The workspace configuration was saved and will apply on the next capture start."
        };
        return Ok(json!({
            "workspace": workspace_status_json(&workspace, "unknown"),
            "saved": true,
            "applied": false,
            "restarted": false,
            "warning": warning,
        }));
    }

    match start_proxy_impl(
        StartProxyInput {
            workspace_id,
            port: Some(workspace.proxy_port),
            enable_ssl: Some(workspace.ssl_enabled),
            enable_http2: Some(workspace.http2_enabled),
        },
        Arc::clone(&state),
    )
    .await
    {
        Ok(proxy_status) => Ok(json!({
            "workspace": workspace_status_json(&workspace, "running"),
            "saved": true,
            "applied": true,
            "restarted": true,
            "proxyStatus": proxy_status,
        })),
        Err(error) => Ok(json!({
            "workspace": workspace_status_json(&workspace, "unknown"),
            "saved": true,
            "applied": false,
            "restarted": false,
            "warning": "The workspace configuration was saved, but the proxy restart failed.",
            "restartError": control_error(error),
        })),
    }
}

async fn start_capture(
    state: Arc<AppState>,
    workspace_id: Option<String>,
) -> Result<Value, ControlError> {
    let status = state.read_status();
    let workspace_id = workspace_id
        .or_else(|| status.active_workspace_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let workspace = state
        .read_workspace_manager()
        .load(&workspace_id)
        .ok_or_else(|| {
            ControlError::new(
                "WORKSPACE_NOT_FOUND",
                format!("Workspace not found: {workspace_id}"),
            )
        })?;
    let started = start_proxy_impl(
        StartProxyInput {
            workspace_id,
            port: Some(workspace.proxy_port),
            enable_ssl: Some(workspace.ssl_enabled),
            enable_http2: Some(workspace.http2_enabled),
        },
        Arc::clone(&state),
    )
    .await
    .map_err(control_error)?;
    let cert_state = Arc::clone(&state);
    let certificate =
        tauri::async_runtime::spawn_blocking(move || get_certificate_status_impl(cert_state))
            .await
            .map_err(|error| {
                ControlError::new(
                    "INTERNAL_ERROR",
                    format!("certificate status task: {error}"),
                )
            })?
            .map_err(control_error)?;
    let mut warnings = Vec::new();
    if started.ssl_enabled && !certificate.trusted {
        warnings.push(
            "Capture is running, but the root certificate is not trusted. HTTPS clients will reject intercepted connections until trust is installed.",
        );
    }
    Ok(json!({
        "status": started,
        "certificate": certificate,
        "warnings": warnings,
    }))
}

async fn stop_capture(
    state: Arc<AppState>,
    workspace_id: Option<String>,
) -> Result<Value, ControlError> {
    let active_workspace_id = state
        .read_status()
        .active_workspace_id
        .unwrap_or_else(|| "default".to_string());
    ensure_active_workspace(workspace_id.as_deref(), &active_workspace_id)?;
    let status = stop_proxy_impl(
        StopProxyInput {
            workspace_id: active_workspace_id,
        },
        Arc::clone(&state),
    )
    .await
    .map_err(control_error)?;
    Ok(stop_capture_payload(status))
}

fn ensure_active_workspace(
    requested: Option<&str>,
    active_workspace_id: &str,
) -> Result<(), ControlError> {
    if requested.is_some_and(|requested| requested != active_workspace_id) {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!(
                "stopCapture only stops the active workspace ({active_workspace_id}). Omit workspaceId or pass the active workspace id."
            ),
        ));
    }
    Ok(())
}

fn stop_capture_payload(status: crate::bootstrap::BootstrapStatus) -> Value {
    let warnings = status
        .system_proxy_recovery_warning
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let system_proxy_restore_failed =
        status.system_proxy_enabled && status.system_proxy_recovery_warning.is_some();
    json!({
        "status": status,
        "systemProxyRestoreFailed": system_proxy_restore_failed,
        "warnings": warnings,
    })
}

async fn set_system_proxy(state: Arc<AppState>, enabled: bool) -> Result<Value, ControlError> {
    let status = if enabled {
        enable_system_proxy_impl(Arc::clone(&state)).await
    } else {
        disable_system_proxy_impl(Arc::clone(&state)).await
    }
    .map_err(control_error)?;
    Ok(json!({ "status": status }))
}

fn ensure_permission(
    config: &AgentAccessConfig,
    operation: &ControlOperation,
) -> Result<(), ControlError> {
    let Some(permission) = operation.required_permission() else {
        return Ok(());
    };
    let enabled = match permission {
        ControlPermission::ControlCapture => config.permissions.control_capture,
        ControlPermission::ControlSystemProxy => config.permissions.control_system_proxy,
        ControlPermission::ManageCertificates => config.permissions.manage_certificates,
        ControlPermission::DeleteSessions => config.permissions.delete_sessions,
        ControlPermission::SendRequests => config.permissions.send_requests,
        ControlPermission::ManageRules => config.permissions.manage_rules,
    };
    if enabled {
        Ok(())
    } else {
        Err(ControlError::new(
            "CONTROL_PERMISSION_DENIED",
            format!(
                "Agent control permission {} is disabled in AIProxy Settings > Agent Access.",
                permission_name(permission)
            ),
        ))
    }
}

fn permission_name(permission: ControlPermission) -> &'static str {
    match permission {
        ControlPermission::ControlCapture => "controlCapture",
        ControlPermission::ControlSystemProxy => "controlSystemProxy",
        ControlPermission::ManageCertificates => "manageCertificates",
        ControlPermission::DeleteSessions => "deleteSessions",
        ControlPermission::SendRequests => "sendRequests",
        ControlPermission::ManageRules => "manageRules",
    }
}

fn validate_operation(operation: &ControlOperation) -> Result<(), ControlError> {
    match operation {
        ControlOperation::ConfigureWorkspace(params) => {
            if !has_workspace_change(params) {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "configureWorkspace requires at least one workspace setting to change.",
                ));
            }
            if params.proxy_port == Some(0) {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "proxyPort must be between 1 and 65535.",
                ));
            }
            if let Some(id) = &params.workspace_id {
                validate_id(id, "workspaceId")?;
            }
            if params
                .ssl_blind_hosts
                .as_ref()
                .is_some_and(|hosts| hosts.len() > 500)
            {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "sslBlindHosts accepts at most 500 entries.",
                ));
            }
            if params
                .ssl_blind_hosts
                .as_ref()
                .is_some_and(|hosts| hosts.iter().any(|host| host.trim().is_empty()))
            {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "sslBlindHosts must not contain empty entries.",
                ));
            }
            if let Some(policy) = &params.ssl_proxying {
                if policy.include.len() > 500 || policy.exclude.len() > 500 {
                    return Err(ControlError::new(
                        "INVALID_ARGUMENT",
                        "SSL proxying include/exclude lists accept at most 500 entries each.",
                    ));
                }
                if policy
                    .include
                    .iter()
                    .chain(policy.exclude.iter())
                    .any(|entry| entry.pattern.len() > 1024)
                {
                    return Err(ControlError::new(
                        "INVALID_ARGUMENT",
                        "An SSL proxying pattern exceeds the 1024 byte limit.",
                    ));
                }
                if policy
                    .include
                    .iter()
                    .chain(policy.exclude.iter())
                    .any(|entry| entry.pattern.trim().is_empty())
                {
                    return Err(ControlError::new(
                        "INVALID_ARGUMENT",
                        "SSL proxying patterns must not be empty.",
                    ));
                }
            }
        }
        ControlOperation::StartCapture(params) | ControlOperation::StopCapture(params) => {
            if let Some(id) = &params.workspace_id {
                validate_id(id, "workspaceId")?;
            }
        }
        ControlOperation::DeleteSessions(params) => {
            if params.session_ids.is_empty() || params.session_ids.len() > 200 {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "deleteSessions accepts 1-200 session ids.",
                ));
            }
            if params
                .session_ids
                .iter()
                .any(|id| id.trim().is_empty() || id.len() > 256)
            {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "Each session id must be 1-256 bytes.",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn has_workspace_change(params: &ConfigureWorkspaceParams) -> bool {
    params.proxy_port.is_some()
        || params.ssl_enabled.is_some()
        || params.http2_enabled.is_some()
        || params.ssl_blind_hosts.is_some()
        || params.ssl_proxying.is_some()
}

fn validate_id(id: &str, field: &str) -> Result<(), ControlError> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!("{field} must be 1-128 bytes."),
        ));
    }
    Ok(())
}

fn control_error(error: impl Into<String>) -> ControlError {
    let message = error.into();
    if let Ok(value) = serde_json::from_str::<Value>(&message) {
        if let (Some(code), Some(message)) = (
            value.get("code").and_then(Value::as_str),
            value.get("message").and_then(Value::as_str),
        ) {
            let mut control_error = ControlError::new(code, message);
            if let Some(details) = value.get("details") {
                control_error = control_error.with_details(details.clone());
            }
            return control_error;
        }
    }
    ControlError::new("INTERNAL_ERROR", message)
}

/// Return only workspace state that is useful for Agent decisions. In
/// particular, never include upstream-proxy credentials in a control response.
fn workspace_status_json(
    workspace: &crate::workspace::WorkspaceData,
    runtime_status: &str,
) -> Value {
    json!({
        "workspaceId": workspace.id,
        "name": workspace.name,
        "proxyPort": workspace.proxy_port,
        "sslEnabled": workspace.ssl_enabled,
        "http2Enabled": workspace.http2_enabled,
        "systemProxyEnabled": workspace.system_proxy_enabled,
        "verifyUpstreamTls": workspace.verify_upstream_tls,
        "tlsVerifyHosts": workspace.tls_verify_hosts,
        "sslBlindHosts": workspace.ssl_blind_hosts,
        "sslProxying": workspace.ssl_proxying,
        "upstreamProxyConfigured": workspace.upstream_proxy.is_some(),
        "upstreamProxyEnabled": workspace
            .upstream_proxy
            .as_ref()
            .is_some_and(|settings| settings.enabled),
        "runtimeStatus": runtime_status,
    })
}

fn control_endpoint(data_dir: &Path) -> String {
    #[cfg(unix)]
    {
        data_dir
            .join("agent-control.sock")
            .to_string_lossy()
            .to_string()
    }
    #[cfg(windows)]
    {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        data_dir.hash(&mut hasher);
        format!("aiproxy-agent-control-{:016x}", hasher.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_mcp::config::{write_config, AgentAccessConfig, AgentAccessPermissions};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn control_request(operation: ControlOperation) -> ControlRequest {
        ControlRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: "request-1".to_string(),
            token: TOKEN.to_string(),
            client_name: Some("codex".to_string()),
            client_version: Some("1.0".to_string()),
            operation,
        }
    }

    fn write_agent_config(data_dir: &Path, enabled: bool, permissions: AgentAccessPermissions) {
        write_config(
            &data_dir.join("agent-access.json"),
            &AgentAccessConfig {
                enabled,
                permissions,
                ..AgentAccessConfig::default()
            },
        )
        .unwrap();
    }

    fn all_control_permissions() -> AgentAccessPermissions {
        AgentAccessPermissions {
            control_capture: true,
            control_system_proxy: true,
            manage_certificates: true,
            delete_sessions: true,
            ..AgentAccessPermissions::default()
        }
    }

    #[test]
    fn preflight_accepts_an_authorized_control_request() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let request = control_request(ControlOperation::StopCapture(
            aiproxy_agent_control::WorkspaceParams::default(),
        ));

        preflight_request(TOKEN, directory.path(), &request).unwrap();
        assert!(directory.path().join("agent-audit.jsonl").is_file());
    }

    #[test]
    fn preflight_rejects_protocol_and_token_mismatches() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let mut request = control_request(ControlOperation::ClearSessions);
        request.protocol_version = CONTROL_PROTOCOL_VERSION + 1;
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "CONTROL_UNAVAILABLE"
        );

        request.protocol_version = CONTROL_PROTOCOL_VERSION;
        request.token = "fedcba9876543210fedcba9876543210".to_string();
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "CONTROL_PERMISSION_DENIED"
        );
    }

    #[test]
    fn preflight_rejects_disabled_agent_access_and_disabled_permission_groups() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), false, all_control_permissions());
        let request = control_request(ControlOperation::ClearSessions);
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "CONTROL_PERMISSION_DENIED"
        );

        write_agent_config(directory.path(), true, AgentAccessPermissions::default());
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "CONTROL_PERMISSION_DENIED"
        );
    }

    #[test]
    fn preflight_rejects_invalid_delete_arguments_before_dispatch() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let request = control_request(ControlOperation::DeleteSessions(
            aiproxy_agent_control::DeleteSessionsParams {
                session_ids: vec![" ".to_string()],
            },
        ));
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn preflight_rejects_an_empty_workspace_update() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let request = control_request(ControlOperation::ConfigureWorkspace(
            aiproxy_agent_control::ConfigureWorkspaceParams::default(),
        ));
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn preflight_rejects_empty_ssl_entries() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let empty_blind_host = control_request(ControlOperation::ConfigureWorkspace(
            aiproxy_agent_control::ConfigureWorkspaceParams {
                ssl_blind_hosts: Some(vec![" ".to_string()]),
                ..aiproxy_agent_control::ConfigureWorkspaceParams::default()
            },
        ));
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &empty_blind_host)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );

        let empty_pattern = control_request(ControlOperation::ConfigureWorkspace(
            aiproxy_agent_control::ConfigureWorkspaceParams {
                ssl_proxying: Some(aiproxy_agent_control::SslProxyingSettingsDto {
                    include_enabled: true,
                    exclude_enabled: false,
                    include: vec![aiproxy_agent_control::SslProxyEntryDto {
                        pattern: " ".to_string(),
                        enabled: true,
                    }],
                    exclude: Vec::new(),
                }),
                ..aiproxy_agent_control::ConfigureWorkspaceParams::default()
            },
        ));
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &empty_pattern)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn preflight_rejects_a_workspace_id_without_settings() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        let request = control_request(ControlOperation::ConfigureWorkspace(
            aiproxy_agent_control::ConfigureWorkspaceParams {
                workspace_id: Some("default".to_string()),
                ..aiproxy_agent_control::ConfigureWorkspaceParams::default()
            },
        ));
        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn stop_capture_only_accepts_the_active_workspace() {
        assert!(ensure_active_workspace(None, "default").is_ok());
        assert!(ensure_active_workspace(Some("default"), "default").is_ok());
        assert_eq!(
            ensure_active_workspace(Some("other"), "default")
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn stop_capture_payload_exposes_a_failed_system_proxy_restore() {
        let status = crate::bootstrap::BootstrapStatus {
            system_proxy_enabled: true,
            system_proxy_recovery_warning: Some("restore failed".to_string()),
            ..crate::bootstrap::BootstrapStatus::default()
        };
        let payload = stop_capture_payload(status);
        assert_eq!(payload["systemProxyRestoreFailed"], true);
        assert_eq!(payload["warnings"][0], "restore failed");
    }

    #[test]
    fn preflight_refuses_a_write_when_the_audit_destination_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        write_agent_config(directory.path(), true, all_control_permissions());
        std::fs::create_dir(directory.path().join("agent-audit.jsonl")).unwrap();
        let request = control_request(ControlOperation::ClearSessions);

        assert_eq!(
            preflight_request(TOKEN, directory.path(), &request)
                .unwrap_err()
                .code,
            "AUDIT_UNAVAILABLE"
        );
    }

    #[test]
    fn control_audit_records_success_failure_identity_and_error_code() {
        let directory = tempfile::tempdir().unwrap();
        let started = Instant::now();
        append_control_audit(
            directory.path(),
            "codex",
            "1.0",
            "delete_sessions",
            "Delete 2 sessions by id",
            started,
            &ControlResponse::success(
                "request-1".to_string(),
                json!({ "deletedCount": 2, "requestSecret": "do-not-audit" }),
            ),
        )
        .unwrap();
        append_control_audit(
            directory.path(),
            "claude",
            "2.0",
            "start_capture",
            "Start capture for workspace default",
            started,
            &ControlResponse::failure(
                "request-2".to_string(),
                ControlError::new("PROXY_START_FAILED", "port is already in use"),
            ),
        )
        .unwrap();

        let contents = std::fs::read_to_string(directory.path().join("agent-audit.jsonl")).unwrap();
        let entries = contents
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["clientName"], "codex");
        assert_eq!(entries[0]["tool"], "delete_sessions");
        assert_eq!(entries[0]["agentControl"], true);
        assert_eq!(entries[0]["outcome"], "success");
        assert_eq!(entries[1]["clientName"], "claude");
        assert_eq!(entries[1]["outcome"], "error");
        assert_eq!(entries[1]["errorCode"], "PROXY_START_FAILED");
        assert!(!contents.contains("requestSecret"));
        assert!(!contents.contains("do-not-audit"));
    }

    #[test]
    fn audit_identity_is_bounded() {
        assert_eq!(audit_identity(None), "unknown");
        assert_eq!(audit_identity(Some("codex")), "codex");
        assert_eq!(audit_identity(Some(&"x".repeat(300))).len(), 128);
    }

    #[test]
    fn diagnostic_log_level_filter_keeps_warnings_and_errors() {
        assert!(line_matches_level(
            "2026-10-29 WARN disk space low",
            DiagnosticLogLevel::Warning
        ));
        assert!(line_matches_level(
            "2026-10-29 ERROR port in use",
            DiagnosticLogLevel::Warning
        ));
        assert!(!line_matches_level(
            "2026-10-29 INFO started",
            DiagnosticLogLevel::Warning
        ));
        assert!(!line_matches_level(
            "2026-10-29 WARN disk space low",
            DiagnosticLogLevel::Error
        ));
        assert!(line_matches_level(
            "2026-10-29 INFO started",
            DiagnosticLogLevel::Any
        ));
        assert!(line_matches_level(
            "ERROR capture start failed",
            DiagnosticLogLevel::Error
        ));
        assert!(line_matches_level(
            "WARN port in use",
            DiagnosticLogLevel::Warning
        ));
        assert!(line_matches_level(
            "2026-10-29 error lowercase failure",
            DiagnosticLogLevel::Error
        ));
        assert!(!line_matches_level(
            "2026-10-29 INFO errorCode=PANIC handled",
            DiagnosticLogLevel::Error
        ));
    }

    #[test]
    fn diagnostic_audit_evidence_is_newest_first_and_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-audit.jsonl");
        let mut contents = String::new();
        for index in 0..60 {
            contents.push_str(&format!(
                "{{\"tool\":\"search_sessions\",\"outcome\":\"error\",\"errorCode\":\"E{index}\"}}\n"
            ));
        }
        std::fs::write(&path, contents).unwrap();
        let (entries, truncated) = read_audit_evidence(directory.path(), None, 5).unwrap();
        assert!(truncated);
        assert_eq!(entries.len(), 10);
        assert_eq!(entries[0]["errorCode"], "E59");
        assert_eq!(entries[9]["errorCode"], "E50");
    }

    #[test]
    fn diagnostic_audit_truncation_requires_a_dropped_matching_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-audit.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"errorCode\":\"E1\"}\n",
                "{\"errorCode\":\"E2\"}\n",
                "{\"partial\":\n",
            ),
        )
        .unwrap();

        let (entries, truncated) = read_audit_evidence(directory.path(), None, 1).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["errorCode"], "E2");
    }

    #[test]
    fn control_request_parse_errors_preserve_compatibility_and_argument_codes() {
        #[derive(Debug, serde::Deserialize)]
        #[serde(tag = "method", content = "params", rename_all = "camelCase")]
        enum OlderControlOperation {
            GetStatus,
        }

        let error = serde_json::from_value::<OlderControlOperation>(json!({
            "method": "readDiagnosticLogs",
            "params": {}
        }))
        .unwrap_err();
        assert_eq!(
            control_request_parse_error(error).code,
            "CONTROL_UNAVAILABLE"
        );

        assert_eq!(
            parse_control_request(br#"{"protocolVersion":"invalid"}"#)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn diagnostic_log_response_reports_availability() {
        let directory = tempfile::tempdir().unwrap();
        let response = read_diagnostic_logs(
            directory.path(),
            ReadDiagnosticLogsParams {
                query: None,
                max_lines: 5,
                level: Some(DiagnosticLogLevel::Warning),
                include_app_log: false,
                include_audit_log: false,
            },
        )
        .unwrap();

        assert_eq!(response["available"], true);
        assert_eq!(response["appLog"]["files"], json!([]));
        assert_eq!(response["auditLog"]["entries"], json!([]));
    }

    #[test]
    fn diagnostic_log_read_rejects_zero_and_oversized_limits() {
        for max_lines in [0, DIAGNOSTIC_LOG_MAX_LINES + 1] {
            let result = read_diagnostic_logs(
                Path::new("."),
                ReadDiagnosticLogsParams {
                    query: None,
                    max_lines,
                    level: Some(DiagnosticLogLevel::Any),
                    include_app_log: false,
                    include_audit_log: false,
                },
            );
            assert_eq!(result.unwrap_err().code, "INVALID_ARGUMENT");
        }
    }

    #[test]
    fn diagnostic_app_log_budget_returns_the_newest_lines_without_overshoot() {
        let directory = tempfile::tempdir().unwrap();
        let log_path = directory.path().join("aiproxy-desktop-dev.log");
        let rotated_path = directory.path().join("aiproxy-desktop-dev.2026-10-29.log");
        let mut contents = String::new();
        for index in 0..5 {
            contents.push_str(&format!("2026-10-29 ERROR failure-{index}\n"));
        }
        std::fs::write(&rotated_path, contents).unwrap();
        let previous = std::env::var_os("AIPROXY_DEV_LOG_FILE");
        std::env::set_var("AIPROXY_DEV_LOG_FILE", &log_path);

        let result = read_app_log_evidence(None, DiagnosticLogLevel::Error, 3);

        match previous {
            Some(value) => std::env::set_var("AIPROXY_DEV_LOG_FILE", value),
            None => std::env::remove_var("AIPROXY_DEV_LOG_FILE"),
        }
        let evidence = result.unwrap();
        assert_eq!(evidence[0]["returnedLines"], 3);
        assert_eq!(evidence[0]["truncated"], true);
        assert_eq!(evidence[0]["lines"][0], "2026-10-29 ERROR failure-4");
        assert_eq!(evidence[0]["lines"][2], "2026-10-29 ERROR failure-2");
    }

    #[test]
    fn connection_permit_enforces_the_limit_and_releases_slots() {
        let active = Arc::new(AtomicUsize::new(0));
        let first = acquire_connection_permit(&active, 2).unwrap();
        let second = acquire_connection_permit(&active, 2).unwrap();
        assert!(acquire_connection_permit(&active, 2).is_none());
        assert_eq!(active.load(Ordering::Acquire), 2);

        drop(first);
        let replacement = acquire_connection_permit(&active, 2).unwrap();
        assert_eq!(active.load(Ordering::Acquire), 2);

        drop(second);
        drop(replacement);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn workspace_status_omits_upstream_proxy_credentials() {
        let workspace = crate::workspace::WorkspaceData {
            id: "default".to_string(),
            name: "Default".to_string(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: Vec::new(),
            ssl_blind_hosts: Vec::new(),
            upstream_proxy: Some(aiproxy_proxy_core::UpstreamProxySettings {
                enabled: true,
                username: Some("workspace-user".to_string()),
                password: Some("workspace-secret".to_string()),
                ..aiproxy_proxy_core::UpstreamProxySettings::default()
            }),
            ssl_proxying: None,
            storage_path: "/tmp/aiproxy".to_string(),
            created_at: "2026-10-26T00:00:00Z".to_string(),
            updated_at: "2026-10-26T00:00:00Z".to_string(),
        };

        let rendered = workspace_status_json(&workspace, "unknown").to_string();
        assert!(rendered.contains("upstreamProxyEnabled"));
        assert!(!rendered.contains("workspace-user"));
        assert!(!rendered.contains("workspace-secret"));
    }
}
