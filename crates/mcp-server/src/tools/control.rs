use aiproxy_agent_control::{
    ConfigureWorkspaceParams, ControlOperation, DeleteSessionsParams, GenerateCertificateParams,
    SetSystemProxyParams, SslProxyEntryDto, SslProxyingSettingsDto, WorkspaceParams,
    CONTROL_PROTOCOL_VERSION,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::AgentAccessConfig;
use crate::context::AppContext;
use crate::control_client::{
    call_control, operation_has_permission, permission_label, try_control, ControlCaller,
};
use crate::protocol::{ToolError, ToolMeta};
use crate::status::read_capture_status;

const MAX_DELETE_SESSION_IDS: usize = 200;
const MAX_SSL_PATTERN_LENGTH: usize = 1024;
const MAX_SSL_ENTRIES: usize = 500;

pub type ToolResult = Result<(Value, ToolMeta), ToolError>;

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureWorkspaceRequest {
    /// Workspace id to update. Omit to use the active workspace.
    pub workspace_id: Option<String>,
    /// Proxy listening port, 1-65535.
    #[schemars(range(min = 1, max = 65535))]
    pub proxy_port: Option<u16>,
    /// Enable HTTPS interception after the root certificate is trusted.
    pub ssl_enabled: Option<bool>,
    /// Enable HTTP/2 support for the proxy listener.
    pub http2_enabled: Option<bool>,
    /// Hosts that should pass through without TLS interception.
    pub ssl_blind_hosts: Option<Vec<String>>,
    /// Include/exclude SSL proxying policy by host pattern.
    pub ssl_proxying: Option<SslProxyingRequest>,
    /// Restart a running proxy after saving. Defaults to true.
    pub apply_now: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SslProxyingRequest {
    /// Whether the include list is enabled.
    pub include_enabled: bool,
    /// Whether the exclude list is enabled.
    pub exclude_enabled: bool,
    /// Host patterns to intercept when include mode is enabled.
    pub include: Vec<SslProxyEntryRequest>,
    /// Host patterns to exclude from interception when exclude mode is enabled.
    pub exclude: Vec<SslProxyEntryRequest>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SslProxyEntryRequest {
    /// Host pattern, at most 1024 characters.
    pub pattern: String,
    /// Whether this entry participates in matching.
    pub enabled: bool,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    /// Workspace id to start. Omit to use the active workspace.
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSystemProxyRequest {
    /// true enables the operating-system proxy; false restores the prior setting.
    pub enabled: bool,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateCertificateRequest {
    /// Replace the existing root certificate. Invalidates prior trust installs.
    pub force_regenerate: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSessionsRequest {
    /// One to two hundred exact session ids to delete.
    pub session_ids: Vec<String>,
}

pub fn action_summary(operation: &ControlOperation) -> String {
    operation.action_summary()
}

pub async fn get_app_status(state: &AppContext) -> ToolResult {
    state.config()?;
    match try_control(&state.paths, ControlOperation::GetStatus).await {
        Ok(mut value) => {
            value["controlAvailable"] = json!(true);
            Ok((value, ToolMeta::new(false, false, None)))
        }
        Err(error) if should_degrade_status_error(&error) => Ok((
            unavailable_status(state, Some(&error)),
            ToolMeta::new(false, false, None),
        )),
        Err(error) => Err(error),
    }
}

fn should_degrade_status_error(error: &ToolError) -> bool {
    matches!(
        error.code.as_str(),
        "CONTROL_UNAVAILABLE" | "CONTROL_TIMEOUT"
    )
}

pub async fn configure_workspace(
    state: &AppContext,
    request: ConfigureWorkspaceRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(
        &config,
        &ControlOperation::ConfigureWorkspace(Default::default()),
    )?;
    ensure_audit(state)?;
    let params = ConfigureWorkspaceParams {
        workspace_id: normalize_optional_id(request.workspace_id, "workspaceId")?,
        proxy_port: request.proxy_port,
        ssl_enabled: request.ssl_enabled,
        http2_enabled: request.http2_enabled,
        ssl_blind_hosts: request.ssl_blind_hosts.map(validate_hosts).transpose()?,
        ssl_proxying: request
            .ssl_proxying
            .map(validate_ssl_proxying)
            .transpose()?,
        apply_now: request.apply_now,
    };
    if !has_workspace_change(&params) {
        return Err(ToolError::invalid(
            "configure_workspace requires at least one workspace setting to change.",
        ));
    }
    let operation = ControlOperation::ConfigureWorkspace(params);
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn start_capture(
    state: &AppContext,
    request: CaptureRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(
        &config,
        &ControlOperation::StartCapture(WorkspaceParams::default()),
    )?;
    ensure_audit(state)?;
    let operation = ControlOperation::StartCapture(WorkspaceParams {
        workspace_id: normalize_optional_id(request.workspace_id, "workspaceId")?,
    });
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn stop_capture(
    state: &AppContext,
    request: CaptureRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(
        &config,
        &ControlOperation::StopCapture(WorkspaceParams::default()),
    )?;
    ensure_audit(state)?;
    let operation = ControlOperation::StopCapture(WorkspaceParams {
        workspace_id: normalize_optional_id(request.workspace_id, "workspaceId")?,
    });
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn set_system_proxy(
    state: &AppContext,
    request: SetSystemProxyRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(
        &config,
        &ControlOperation::SetSystemProxy(SetSystemProxyParams {
            enabled: request.enabled,
        }),
    )?;
    ensure_audit(state)?;
    let value = call_control(
        &state.paths,
        ControlOperation::SetSystemProxy(SetSystemProxyParams {
            enabled: request.enabled,
        }),
        true,
        caller,
    )
    .await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn generate_certificate(
    state: &AppContext,
    request: GenerateCertificateRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(
        &config,
        &ControlOperation::GenerateCertificate(GenerateCertificateParams::default()),
    )?;
    ensure_audit(state)?;
    let operation = ControlOperation::GenerateCertificate(GenerateCertificateParams {
        force_regenerate: request.force_regenerate.unwrap_or(false),
    });
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn open_certificate_installer(
    state: &AppContext,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(&config, &ControlOperation::OpenCertificateInstaller)?;
    ensure_audit(state)?;
    let value = call_control(
        &state.paths,
        ControlOperation::OpenCertificateInstaller,
        true,
        caller,
    )
    .await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn remove_certificate_trust(state: &AppContext, caller: ControlCaller<'_>) -> ToolResult {
    let config = state.config()?;
    ensure_permission(&config, &ControlOperation::RemoveCertificateTrust)?;
    ensure_audit(state)?;
    let value = call_control(
        &state.paths,
        ControlOperation::RemoveCertificateTrust,
        true,
        caller,
    )
    .await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn clear_sessions(state: &AppContext, caller: ControlCaller<'_>) -> ToolResult {
    let config = state.config()?;
    ensure_permission(&config, &ControlOperation::ClearSessions)?;
    ensure_audit(state)?;
    let value = call_control(&state.paths, ControlOperation::ClearSessions, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn delete_sessions(
    state: &AppContext,
    request: DeleteSessionsRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let ids = validate_session_ids(request.session_ids)?;
    let config = state.config()?;
    let operation = ControlOperation::DeleteSessions(DeleteSessionsParams { session_ids: ids });
    ensure_permission(&config, &operation)?;
    ensure_audit(state)?;
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub(crate) fn ensure_permission(
    config: &AgentAccessConfig,
    operation: &ControlOperation,
) -> Result<(), ToolError> {
    let Some(permission) = operation.required_permission() else {
        return Ok(());
    };
    if operation_has_permission(config, permission) {
        return Ok(());
    }
    Err(ToolError::new(
        "CONTROL_PERMISSION_DENIED",
        format!(
            "Agent control permission {} is disabled. Enable it in AIProxy Settings > Agent Access > Control permissions.",
            permission_label(permission)
        ),
    ))
}

pub(crate) fn ensure_audit(state: &AppContext) -> Result<(), ToolError> {
    state.audit.check_writable().map_err(|error| {
        ToolError::new(
            "AUDIT_UNAVAILABLE",
            format!(
                "The Agent audit log is not writable, so this control action was not executed: {error}"
            ),
        )
        .with_details(json!({ "path": state.audit.path().display().to_string() }))
    })
}

fn normalize_optional_id(value: Option<String>, field: &str) -> Result<Option<String>, ToolError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(ToolError::invalid(format!("{field} must be 1-128 bytes.")));
    }
    Ok(Some(value.to_string()))
}

fn has_workspace_change(params: &ConfigureWorkspaceParams) -> bool {
    params.proxy_port.is_some()
        || params.ssl_enabled.is_some()
        || params.http2_enabled.is_some()
        || params.ssl_blind_hosts.is_some()
        || params.ssl_proxying.is_some()
}

fn validate_hosts(hosts: Vec<String>) -> Result<Vec<String>, ToolError> {
    if hosts.len() > MAX_SSL_ENTRIES {
        return Err(ToolError::invalid(format!(
            "sslBlindHosts accepts at most {MAX_SSL_ENTRIES} entries."
        )));
    }
    let hosts = hosts
        .into_iter()
        .map(|host| host.trim().to_string())
        .collect::<Vec<_>>();
    if hosts.iter().any(String::is_empty) {
        return Err(ToolError::invalid(
            "sslBlindHosts must not contain empty entries.",
        ));
    }
    Ok(hosts)
}

fn validate_ssl_proxying(
    settings: SslProxyingRequest,
) -> Result<SslProxyingSettingsDto, ToolError> {
    if settings.include.len() > MAX_SSL_ENTRIES || settings.exclude.len() > MAX_SSL_ENTRIES {
        return Err(ToolError::invalid(format!(
            "SSL proxying include/exclude lists accept at most {MAX_SSL_ENTRIES} entries each."
        )));
    }
    Ok(SslProxyingSettingsDto {
        include_enabled: settings.include_enabled,
        exclude_enabled: settings.exclude_enabled,
        include: validate_ssl_entries(settings.include)?,
        exclude: validate_ssl_entries(settings.exclude)?,
    })
}

fn validate_ssl_entries(
    entries: Vec<SslProxyEntryRequest>,
) -> Result<Vec<SslProxyEntryDto>, ToolError> {
    entries
        .into_iter()
        .map(|entry| {
            let pattern = entry.pattern.trim();
            if pattern.is_empty() {
                return Err(ToolError::invalid(
                    "SSL proxying patterns must not be empty.",
                ));
            }
            if pattern.len() > MAX_SSL_PATTERN_LENGTH {
                return Err(ToolError::invalid(format!(
                    "An SSL proxying pattern exceeds the {MAX_SSL_PATTERN_LENGTH} byte limit."
                )));
            }
            Ok(SslProxyEntryDto {
                pattern: pattern.to_string(),
                enabled: entry.enabled,
            })
        })
        .collect()
}

fn validate_session_ids(session_ids: Vec<String>) -> Result<Vec<String>, ToolError> {
    if session_ids.is_empty() || session_ids.len() > MAX_DELETE_SESSION_IDS {
        return Err(ToolError::invalid(format!(
            "delete_sessions accepts 1-{MAX_DELETE_SESSION_IDS} session ids per call."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::with_capacity(session_ids.len());
    for id in session_ids {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err(ToolError::invalid(
                "delete_sessions session ids must not be empty.",
            ));
        }
        if id.len() > 256 {
            return Err(ToolError::invalid(
                "A session id exceeds the 256 byte limit.",
            ));
        }
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn unavailable_status(state: &AppContext, control_error: Option<&ToolError>) -> Value {
    let capture = read_capture_status(&state.paths.data_dir);
    json!({
        "appRunning": capture.app_running,
        "controlAvailable": false,
        "protocolVersion": CONTROL_PROTOCOL_VERSION,
        "controlError": control_error.map(|error| json!({
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
        })),
        "capture": {
            "status": capture.status,
            "updatedAt": capture.updated_at,
        },
        "certificate": {
            "known": false,
            "trusted": false,
            "path": null,
        },
        "workspaces": [],
        "systemProxy": {
            "known": false,
            "enabled": false,
        },
        "nextSteps": [
            "Start AIProxy to enable certificate, workspace, and proxy status checks.",
            "Write tools can launch AIProxy automatically when their control permission is enabled."
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_id_alone_is_not_a_configuration_change() {
        let params = ConfigureWorkspaceParams {
            workspace_id: Some("default".to_string()),
            ..ConfigureWorkspaceParams::default()
        };
        assert!(!has_workspace_change(&params));

        let params = ConfigureWorkspaceParams {
            proxy_port: Some(8899),
            ..params
        };
        assert!(has_workspace_change(&params));
    }

    #[test]
    fn unavailable_status_preserves_protocol_mismatch_details() {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::config::AppPaths {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("aiproxy.db"),
            body_dir: directory.path().join("bodies"),
            config_path: directory.path().join("agent-access.json"),
            audit_path: directory.path().join("agent-audit.jsonl"),
        };
        let state = AppContext::new(paths);
        let error = ToolError::new(
            "CONTROL_UNAVAILABLE",
            "Update AIProxy and its MCP sidecar together.",
        );

        let status = unavailable_status(&state, Some(&error));
        assert_eq!(status["controlAvailable"], false);
        assert!(status.get("permissions").is_none());
        assert_eq!(status["controlError"]["code"], "CONTROL_UNAVAILABLE");
        assert_eq!(
            status["controlError"]["message"],
            "Update AIProxy and its MCP sidecar together."
        );
    }

    #[test]
    fn status_degrades_when_the_control_probe_times_out() {
        assert!(should_degrade_status_error(&ToolError::new(
            "CONTROL_UNAVAILABLE",
            "not running"
        )));
        assert!(should_degrade_status_error(&ToolError::new(
            "CONTROL_TIMEOUT",
            "probe timed out"
        )));
        assert!(!should_degrade_status_error(&ToolError::new(
            "INVALID_ARGUMENT",
            "bad request"
        )));
    }

    #[test]
    fn ssl_validation_rejects_instead_of_silently_truncating() {
        assert!(validate_hosts(vec!["api.example.com".to_string()]).is_ok());
        assert!(validate_hosts(vec!["".to_string()]).is_err());
        assert!(validate_hosts(vec!["api.example.com".to_string(); MAX_SSL_ENTRIES + 1]).is_err());

        assert!(validate_ssl_entries(vec![SslProxyEntryRequest {
            pattern: "api.example.com".to_string(),
            enabled: true,
        }])
        .is_ok());
        assert!(validate_ssl_entries(vec![SslProxyEntryRequest {
            pattern: " ".to_string(),
            enabled: true,
        }])
        .is_err());
        assert!(validate_ssl_entries(vec![SslProxyEntryRequest {
            pattern: "a".repeat(MAX_SSL_PATTERN_LENGTH + 1),
            enabled: true,
        }])
        .is_err());
    }

    #[test]
    fn workspace_and_session_ids_reject_ambiguous_empty_values() {
        assert!(normalize_optional_id(None, "workspaceId")
            .unwrap()
            .is_none());
        assert_eq!(
            normalize_optional_id(Some(" default ".to_string()), "workspaceId").unwrap(),
            Some("default".to_string())
        );
        assert!(normalize_optional_id(Some("  ".to_string()), "workspaceId").is_err());
        assert!(validate_session_ids(vec!["session-1".into(), " ".into()]).is_err());

        let too_many = (0..=MAX_DELETE_SESSION_IDS)
            .map(|index| format!("session-{index}"))
            .collect::<Vec<_>>();
        assert!(validate_session_ids(too_many).is_err());
        assert_eq!(
            validate_session_ids(vec![" a ".into(), "a".into(), "b".into()]).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }
}
