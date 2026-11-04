use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use aiproxy_agent_control::{
    capability_action_fingerprint, operation_action_fingerprint, read_descriptor, read_json_line,
    token_matches, write_json_line_with_limit, AgentCapability, AgentGrant,
    AgentGrantApprovalOption, AgentGrantCleanupPolicy, AgentGrantRequest, AgentGrantRequestPolicy,
    AgentGrantResourcePolicy, AgentGrantScope, AgentGrantStatus, AutomationResourceLifecycle,
    ConsumeAgentGrantParams, ControlDescriptor, ControlError, ControlOperation, ControlPermission,
    ControlRequest, ControlResponse, CONTROL_MAX_REQUEST_BYTES, CONTROL_MAX_RESPONSE_BYTES,
    CONTROL_PROTOCOL_VERSION, CONTROL_WRITE_TIMEOUT_SECS,
};
use interprocess::local_socket::{prelude::*, Stream};
use serde_json::Value;

use crate::config::{AgentAccessConfig, AppPaths};
use crate::protocol::ToolError;
use crate::status::read_capture_status;

const APP_LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);
const APP_LAUNCH_POLL_INTERVAL: Duration = Duration::from_millis(150);
// Status reads enrich other tools but must never make a read-only MCP call
// wait for the full write timeout when the desktop process is unresponsive.
const CONTROL_STATUS_TIMEOUT_SECS: u64 = 5;
const GRANT_APPROVAL_TIMEOUT_SECS: u64 = 40;

static AGENT_INSTANCE_ID: OnceLock<String> = OnceLock::new();

pub fn initialize_agent_instance_id() -> String {
    AGENT_INSTANCE_ID
        .get_or_init(|| format!("mcp_{}", uuid::Uuid::new_v4().simple()))
        .clone()
}

fn agent_instance_id() -> String {
    initialize_agent_instance_id()
}

/// MCP client identity forwarded with control writes so the desktop can write
/// the authoritative audit entry even when a local process talks to IPC
/// directly without going through this sidecar.
#[derive(Debug, Clone, Copy)]
pub struct ControlCaller<'a> {
    pub name: &'a str,
    pub version: &'a str,
}

impl Default for ControlCaller<'_> {
    fn default() -> Self {
        Self {
            name: "unknown",
            version: "unknown",
        }
    }
}

pub fn operation_has_permission(config: &AgentAccessConfig, permission: ControlPermission) -> bool {
    match permission {
        ControlPermission::ControlCapture => config.permissions.control_capture,
        ControlPermission::ControlSystemProxy => config.permissions.control_system_proxy,
        ControlPermission::ManageCertificates => config.permissions.manage_certificates,
        ControlPermission::DeleteSessions => config.permissions.delete_sessions,
        ControlPermission::SendRequests => config.permissions.send_requests,
        ControlPermission::ManageRules => config.permissions.manage_rules,
        ControlPermission::ManageAutomation => config.permissions.manage_automation,
        ControlPermission::ManageUserAutomation => config.permissions.manage_user_automation,
        ControlPermission::ManageScripts => config.permissions.manage_scripts,
        ControlPermission::ManageCrossHostMappings => config.permissions.manage_cross_host_mappings,
        ControlPermission::ManageProxiedVerification => {
            config.permissions.manage_proxied_verification
        }
        ControlPermission::ManageGlobalAutomation => config.permissions.manage_global_automation,
    }
}

pub fn permission_label(permission: ControlPermission) -> &'static str {
    match permission {
        ControlPermission::ControlCapture => "controlCapture",
        ControlPermission::ControlSystemProxy => "controlSystemProxy",
        ControlPermission::ManageCertificates => "manageCertificates",
        ControlPermission::DeleteSessions => "deleteSessions",
        ControlPermission::SendRequests => "sendRequests",
        ControlPermission::ManageRules => "manageRules",
        ControlPermission::ManageAutomation => "manageAutomation",
        ControlPermission::ManageUserAutomation => "manageUserAutomation",
        ControlPermission::ManageScripts => "manageScripts",
        ControlPermission::ManageCrossHostMappings => "manageCrossHostMappings",
        ControlPermission::ManageProxiedVerification => "manageProxiedVerification",
        ControlPermission::ManageGlobalAutomation => "manageGlobalAutomation",
    }
}

#[derive(Debug, Clone, Default)]
struct ControlAuth {
    grant_ids: Vec<String>,
    action_fingerprint: Option<String>,
}

async fn prepare_control_auth(
    paths: &AppPaths,
    descriptor: &ControlDescriptor,
    operation: &ControlOperation,
    caller: ControlCaller<'_>,
) -> Result<ControlAuth, ToolError> {
    let config = crate::config::read_config(&paths.config_path)
        .map_err(|error| ToolError::new("AGENT_ACCESS_DISABLED", error.message()))?;
    if !config.enabled {
        return Err(ToolError::disabled());
    }
    let missing = operation
        .required_permissions()
        .into_iter()
        .filter(|permission| !operation_has_permission(&config, *permission))
        .collect::<Vec<_>>();
    let mut grant_ids = Vec::new();
    for permission in missing {
        let capability = capability_for_permission(permission);
        if config.grant_request_policy.get(&capability) != Some(&AgentGrantRequestPolicy::Ask) {
            return Err(ToolError::new(
                "CONTROL_PERMISSION_DENIED",
                format!(
                    "Agent control permission {} is disabled and is not allowed to request temporary approval.",
                    permission_label(permission)
                ),
            ));
        }
        let request = AgentGrantRequest {
            capability,
            action_fingerprint: operation_action_fingerprint(operation),
            action_summary: operation.action_summary(),
            scope: operation_scope(operation),
            reason: format!(
                "The Agent needs temporary {} access for this specific action.",
                permission_label(permission)
            ),
            approval_options: approval_options(operation, operation_non_idempotent(operation)),
            expires_in_seconds: 30,
            non_idempotent: operation_non_idempotent(operation),
            resource_policy: operation_resource_policy(operation),
        };
        let grant = request_grant_with_descriptor(descriptor, request, caller).await?;
        grant_ids.push(grant.id);
    }
    Ok(ControlAuth {
        grant_ids,
        action_fingerprint: Some(operation_action_fingerprint(operation)),
    })
}

#[derive(Debug, Clone)]
pub struct CapabilityGrantRequest {
    pub capability: AgentCapability,
    pub action_summary: String,
    pub scope: AgentGrantScope,
    pub reason: String,
    pub non_idempotent: bool,
    pub resource_policy: Option<AgentGrantResourcePolicy>,
}

pub async fn request_capability_grant(
    paths: &AppPaths,
    request: CapabilityGrantRequest,
    caller: ControlCaller<'_>,
) -> Result<AgentGrant, ToolError> {
    let descriptor = resolve_descriptor(paths, true).await?;
    let request = AgentGrantRequest {
        capability: request.capability,
        action_fingerprint: capability_action_fingerprint(request.capability, &request.scope),
        action_summary: request.action_summary,
        scope: request.scope,
        reason: request.reason,
        approval_options: capability_approval_options(request.capability, request.non_idempotent),
        expires_in_seconds: 30,
        non_idempotent: request.non_idempotent,
        resource_policy: request.resource_policy,
    };
    request_grant_with_descriptor(&descriptor, request, caller).await
}

pub async fn consume_capability_grant(
    paths: &AppPaths,
    grant: &AgentGrant,
    caller: ControlCaller<'_>,
) -> Result<AgentGrant, ToolError> {
    let descriptor = resolve_descriptor(paths, false).await?;
    let value = call_once(
        ControlOperation::ConsumeAgentGrant(ConsumeAgentGrantParams {
            grant_id: grant.id.clone(),
            capability: grant.capability,
            action_fingerprint: grant.action_fingerprint.clone(),
        }),
        descriptor,
        CONTROL_STATUS_TIMEOUT_SECS,
        caller,
        &ControlAuth::default(),
    )
    .await?;
    let value = value.get("grant").cloned().ok_or_else(|| {
        ToolError::new(
            "GRANT_CONSUME_FAILED",
            "AIProxy did not return the consumed temporary approval.",
        )
    })?;
    serde_json::from_value(value).map_err(|error| {
        ToolError::new(
            "GRANT_CONSUME_FAILED",
            format!("Parse AIProxy temporary approval: {error}"),
        )
    })
}

async fn resolve_descriptor(
    paths: &AppPaths,
    allow_launch: bool,
) -> Result<ControlDescriptor, ToolError> {
    match read_descriptor(&paths.data_dir).ok() {
        Some(descriptor) => {
            validate_descriptor(&descriptor)?;
            Ok(descriptor)
        }
        None if allow_launch => {
            if desktop_is_already_running(paths) {
                return Err(already_running_without_control_error());
            }
            launch_desktop(paths).await
        }
        None => Err(ToolError::new(
            "CONTROL_UNAVAILABLE",
            "AIProxy is not running or its local Agent control channel is unavailable. Start AIProxy, then retry.",
        )),
    }
}

async fn request_grant_with_descriptor(
    descriptor: &ControlDescriptor,
    request: AgentGrantRequest,
    caller: ControlCaller<'_>,
) -> Result<AgentGrant, ToolError> {
    let value = call_once(
        ControlOperation::RequestAgentGrant(request),
        descriptor.clone(),
        GRANT_APPROVAL_TIMEOUT_SECS,
        caller,
        &ControlAuth::default(),
    )
    .await?;
    let grant: AgentGrant = value
        .get("grant")
        .cloned()
        .ok_or_else(|| {
            ToolError::new(
                "GRANT_REQUEST_FAILED",
                "AIProxy did not return the temporary approval details.",
            )
        })
        .and_then(|value| {
            serde_json::from_value(value).map_err(|error| {
                ToolError::new(
                    "GRANT_REQUEST_FAILED",
                    format!("Parse AIProxy temporary approval: {error}"),
                )
            })
        })?;
    match grant.status {
        AgentGrantStatus::Approved | AgentGrantStatus::Executing => Ok(grant),
        AgentGrantStatus::Denied => Err(ToolError::new(
            "APPROVAL_DENIED",
            "The user denied this temporary Agent permission request.",
        )),
        AgentGrantStatus::Expired => Err(ToolError::new(
            "APPROVAL_TIMEOUT",
            "The temporary Agent permission request expired before it was approved. Ask the user to approve it again.",
        )),
        AgentGrantStatus::Cancelled | AgentGrantStatus::Revoked => Err(ToolError::new(
            "APPROVAL_CANCELLED",
            "The temporary Agent permission request was cancelled.",
        )),
        other => Err(ToolError::new(
            "APPROVAL_REQUIRED",
            format!("The temporary Agent permission request ended with status {other:?}."),
        )
        .with_details(serde_json::json!({
            "requestId": grant.request_id,
            "agentInstanceId": grant.agent_instance_id,
            "actionFingerprint": grant.action_fingerprint,
            "status": other,
        }))),
    }
}

pub fn capability_for_permission(permission: ControlPermission) -> AgentCapability {
    match permission {
        ControlPermission::ControlCapture => AgentCapability::ControlCapture,
        ControlPermission::ControlSystemProxy => AgentCapability::ControlSystemProxy,
        ControlPermission::ManageCertificates => AgentCapability::ManageCertificates,
        ControlPermission::DeleteSessions => AgentCapability::DeleteSessions,
        ControlPermission::SendRequests => AgentCapability::SendRequests,
        ControlPermission::ManageRules => AgentCapability::ManageRules,
        ControlPermission::ManageAutomation => AgentCapability::ManageAutomation,
        ControlPermission::ManageUserAutomation => AgentCapability::ManageUserAutomation,
        ControlPermission::ManageScripts => AgentCapability::ManageScripts,
        ControlPermission::ManageCrossHostMappings => AgentCapability::ManageCrossHostMappings,
        ControlPermission::ManageProxiedVerification => AgentCapability::ManageProxiedVerification,
        ControlPermission::ManageGlobalAutomation => AgentCapability::ManageGlobalAutomation,
    }
}

fn approval_options(
    operation: &ControlOperation,
    non_idempotent: bool,
) -> Vec<AgentGrantApprovalOption> {
    let repeatable = !non_idempotent
        && operation
            .required_permissions()
            .into_iter()
            .all(|permission| capability_allows_repeat(capability_for_permission(permission)));
    if repeatable {
        vec![
            AgentGrantApprovalOption::Once,
            AgentGrantApprovalOption::FifteenMinutes,
        ]
    } else {
        vec![AgentGrantApprovalOption::Once]
    }
}

fn capability_approval_options(
    capability: AgentCapability,
    non_idempotent: bool,
) -> Vec<AgentGrantApprovalOption> {
    if !non_idempotent && capability_allows_repeat(capability) {
        vec![
            AgentGrantApprovalOption::Once,
            AgentGrantApprovalOption::FifteenMinutes,
        ]
    } else {
        vec![AgentGrantApprovalOption::Once]
    }
}

fn capability_allows_repeat(capability: AgentCapability) -> bool {
    !matches!(
        capability,
        AgentCapability::ReadRawBodies
            | AgentCapability::ControlSystemProxy
            | AgentCapability::ManageCertificates
            | AgentCapability::DeleteSessions
            | AgentCapability::ManageUserAutomation
            | AgentCapability::ManageScripts
            | AgentCapability::ManageCrossHostMappings
            | AgentCapability::ManageGlobalAutomation
    )
}

fn operation_non_idempotent(operation: &ControlOperation) -> bool {
    match operation {
        ControlOperation::ReplaySession(params) => params
            .method
            .as_deref()
            .map(|method| {
                !matches!(
                    method.to_ascii_uppercase().as_str(),
                    "GET" | "HEAD" | "OPTIONS"
                )
            })
            .unwrap_or(true),
        ControlOperation::DeleteSessions(_)
        | ControlOperation::ClearSessions
        | ControlOperation::RemoveCertificateTrust
        | ControlOperation::ApplyAutomationPlan(_)
        | ControlOperation::RollbackAutomationChange(_)
        | ControlOperation::ClearAgentAutomation(_) => true,
        _ => false,
    }
}

fn operation_scope(operation: &ControlOperation) -> AgentGrantScope {
    match operation {
        ControlOperation::DeleteSessions(params) => AgentGrantScope {
            session_ids: params.session_ids.clone(),
            ..AgentGrantScope::default()
        },
        ControlOperation::ReplaySession(params) => AgentGrantScope {
            session_ids: vec![params.session_id.clone()],
            methods: params.method.clone().into_iter().collect(),
            ..AgentGrantScope::default()
        },
        ControlOperation::ConfigureWorkspace(params) => AgentGrantScope {
            workspace_id: params.workspace_id.clone(),
            ..AgentGrantScope::default()
        },
        ControlOperation::StartCapture(params) | ControlOperation::StopCapture(params) => {
            AgentGrantScope {
                workspace_id: params.workspace_id.clone(),
                ..AgentGrantScope::default()
            }
        }
        ControlOperation::ApplyAutomationPlan(params) => AgentGrantScope {
            workspace_id: params.plan.workspace_id.clone(),
            ..AgentGrantScope::default()
        },
        ControlOperation::ClearAgentAutomation(params) => AgentGrantScope {
            workspace_id: params.workspace_id.clone(),
            ..AgentGrantScope::default()
        },
        ControlOperation::VerifyAutomationChange(params) => AgentGrantScope {
            session_ids: params
                .baseline_session_ids
                .iter()
                .chain(params.external_session_ids.iter())
                .cloned()
                .collect(),
            ..AgentGrantScope::default()
        },
        _ => AgentGrantScope::default(),
    }
}

fn operation_resource_policy(operation: &ControlOperation) -> Option<AgentGrantResourcePolicy> {
    let plan = match operation {
        ControlOperation::ApplyAutomationPlan(params) => Some(&params.plan),
        ControlOperation::ValidateAutomationPlan(params) => Some(&params.plan),
        _ => None,
    }?;
    Some(AgentGrantResourcePolicy {
        lifecycle: if plan.lifecycle == "ephemeral" {
            AutomationResourceLifecycle::Ephemeral
        } else {
            AutomationResourceLifecycle::Persistent
        },
        ttl_seconds: plan.ttl_seconds,
        cleanup: AgentGrantCleanupPolicy::AgentOwnedOnly,
    })
}

pub async fn call_control(
    paths: &AppPaths,
    operation: ControlOperation,
    allow_launch: bool,
    caller: ControlCaller<'_>,
) -> Result<Value, ToolError> {
    let descriptor = read_descriptor(&paths.data_dir).ok();
    let descriptor = match descriptor {
        Some(descriptor) => descriptor,
        None if allow_launch => {
            if desktop_is_already_running(paths) {
                return Err(already_running_without_control_error());
            }
            launch_desktop(paths).await?
        }
        None => {
            return Err(ToolError::new(
                "CONTROL_UNAVAILABLE",
                "AIProxy is not running or its local Agent control channel is unavailable. Start AIProxy, then retry.",
            ))
        }
    };
    validate_descriptor(&descriptor)?;

    let auth = prepare_control_auth(paths, &descriptor, &operation, caller).await?;

    let first = call_once(
        operation.clone(),
        descriptor.clone(),
        CONTROL_WRITE_TIMEOUT_SECS,
        caller,
        &auth,
    )
    .await;
    match first {
        Ok(value) => Ok(value),
        Err(error) if allow_launch && error.code == "CONTROL_UNAVAILABLE" && error.retryable => {
            // A stale descriptor is common after a crash. The single-instance
            // plugin focuses an already-running app, so launching is safe.
            // Only connection-phase failures are retryable: after the request
            // was sent, a lost response does not prove the write did not run.
            if desktop_is_already_running(paths) {
                return Err(already_running_without_control_error());
            }
            let descriptor = launch_desktop(paths).await?;
            call_once(
                operation,
                descriptor,
                CONTROL_WRITE_TIMEOUT_SECS,
                caller,
                &auth,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

pub async fn try_control(
    paths: &AppPaths,
    operation: ControlOperation,
) -> Result<Value, ToolError> {
    let descriptor = read_descriptor(&paths.data_dir).map_err(|_| {
        ToolError::new(
            "CONTROL_UNAVAILABLE",
            "AIProxy is not running, so its local control channel is unavailable.",
        )
    })?;
    validate_descriptor(&descriptor)?;
    call_once(
        operation,
        descriptor,
        CONTROL_STATUS_TIMEOUT_SECS,
        ControlCaller::default(),
        &ControlAuth::default(),
    )
    .await
}

async fn call_once(
    operation: ControlOperation,
    descriptor: ControlDescriptor,
    timeout_secs: u64,
    caller: ControlCaller<'_>,
    auth: &ControlAuth,
) -> Result<Value, ToolError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = ControlRequest {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        request_id: request_id.clone(),
        token: descriptor.token,
        client_name: Some(caller.name.to_string()),
        client_version: Some(caller.version.to_string()),
        agent_instance_id: Some(agent_instance_id()),
        grant_ids: auth.grant_ids.clone(),
        action_fingerprint: auth.action_fingerprint.clone(),
        operation,
    };
    let is_write = request.operation.is_write();
    let endpoint = descriptor.endpoint;

    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs + 2),
        tokio::task::spawn_blocking(move || send_request(&endpoint, &request, timeout_secs)),
    )
    .await;

    let response = match result {
        Ok(Ok(Ok(response))) => response,
        Ok(Ok(Err(error))) => return Err(error),
        Ok(Err(error)) => {
            return Err(mark_lost_write_response(
                ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("The AIProxy control request task failed: {error}"),
                ),
                is_write,
            ))
        }
        Err(_) => {
            return Err(mark_lost_write_response(
                ToolError::new(
                    "CONTROL_TIMEOUT",
                    format!(
                        "The AIProxy control request exceeded its {timeout_secs} second timeout. Check AIProxy for the current state before retrying."
                    ),
                ),
                is_write,
            ))
        }
    };

    if response.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(mark_lost_write_response(protocol_mismatch(), is_write));
    }
    if response.request_id != request_id {
        return Err(mark_lost_write_response(
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                "AIProxy returned a response for a different control request.",
            ),
            is_write,
        ));
    }
    if response.ok {
        return response.data.ok_or_else(|| {
            mark_lost_write_response(
                ToolError::new(
                    "CONTROL_UNAVAILABLE",
                    "AIProxy returned a successful response without a result payload.",
                ),
                is_write,
            )
        });
    }
    let error = response.error.unwrap_or_else(|| {
        ControlError::new(
            "CONTROL_UNAVAILABLE",
            "AIProxy returned an empty control error.",
        )
    });
    let mut tool_error = ToolError::new(error.code, error.message)
        .retryable(error.retryable)
        .with_remote_audit();
    if let Some(details) = error.details {
        tool_error = tool_error.with_details(details);
    }
    Err(tool_error)
}

fn send_request(
    endpoint: &str,
    request: &ControlRequest,
    timeout_secs: u64,
) -> Result<ControlResponse, ToolError> {
    #[cfg(unix)]
    let name = endpoint
        .to_fs_name::<interprocess::local_socket::GenericFilePath>()
        .map_err(|error| {
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("Invalid AIProxy control endpoint: {error}"),
            )
        })?;
    #[cfg(windows)]
    let name = endpoint
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()
        .map_err(|error| {
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("Invalid AIProxy control endpoint: {error}"),
            )
        })?;

    let mut stream = Stream::connect(name).map_err(|error| {
        control_io_error(
            "Could not connect to the AIProxy control channel",
            error,
            timeout_secs,
        )
        .retryable(true)
    })?;
    stream
        .set_recv_timeout(Some(Duration::from_secs(timeout_secs)))
        .map_err(|error| {
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("Configure the AIProxy control receive timeout: {error}"),
            )
        })?;
    stream
        .set_send_timeout(Some(Duration::from_secs(timeout_secs)))
        .map_err(|error| {
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("Configure the AIProxy control send timeout: {error}"),
            )
        })?;

    let request_bytes = serde_json::to_vec(request).map_err(|error| {
        ToolError::new(
            "INVALID_ARGUMENT",
            format!("Serialize AIProxy control request: {error}"),
        )
    })?;
    if request_bytes.len() > CONTROL_MAX_REQUEST_BYTES {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!(
                "The AIProxy control request is too large ({} bytes, maximum {}).",
                request_bytes.len(),
                CONTROL_MAX_REQUEST_BYTES
            ),
        ));
    }
    write_json_line_with_limit(&mut stream, request, CONTROL_MAX_REQUEST_BYTES)
        .map_err(|error| control_io_error("Write AIProxy control request", error, timeout_secs))?;

    let is_write = request.operation.is_write();
    let mut reader = BufReader::new(stream);
    let response_bytes =
        read_json_line(&mut reader, CONTROL_MAX_RESPONSE_BYTES).map_err(|error| {
            let error = if error.kind() == std::io::ErrorKind::InvalidData {
                ToolError::new(
                    "CONTROL_UNAVAILABLE",
                    "AIProxy returned a control response that exceeded the size limit.",
                )
            } else {
                control_io_error("Read AIProxy control response", error, timeout_secs)
            };
            mark_lost_write_response(error, is_write)
        })?;
    serde_json::from_slice(&response_bytes).map_err(|error| {
        mark_lost_write_response(
            ToolError::new(
                "CONTROL_UNAVAILABLE",
                format!("Parse AIProxy control response: {error}"),
            ),
            is_write,
        )
    })
}

/// Once a write request has reached the socket, the desktop may have executed
/// it and written the authoritative audit entry even if the response was lost.
/// Mark that uncertainty so the sidecar does not append a duplicate error row.
fn mark_lost_write_response(error: ToolError, is_write: bool) -> ToolError {
    if is_write {
        error.with_remote_audit()
    } else {
        error
    }
}

fn control_io_error(context: &str, error: std::io::Error, timeout_secs: u64) -> ToolError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        ToolError::new(
            "CONTROL_TIMEOUT",
            format!(
                "{context} after {} seconds. The action may still be running; check AIProxy status before retrying a non-idempotent operation.",
                timeout_secs
            ),
        )
    } else {
        ToolError::new("CONTROL_UNAVAILABLE", format!("{context}: {error}"))
    }
}

fn validate_descriptor(descriptor: &ControlDescriptor) -> Result<(), ToolError> {
    if descriptor.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(protocol_mismatch());
    }
    if descriptor.endpoint.trim().is_empty() || descriptor.token.len() < 32 {
        return Err(ToolError::new(
            "CONTROL_UNAVAILABLE",
            "The AIProxy control descriptor is incomplete. Restart AIProxy and retry.",
        ));
    }
    Ok(())
}

fn protocol_mismatch() -> ToolError {
    ToolError::new(
        "CONTROL_UNAVAILABLE",
        format!(
            "AIProxy and its MCP sidecar use different Agent control protocol versions. Update both to the latest version and restart AIProxy. This sidecar expects protocol {CONTROL_PROTOCOL_VERSION}."
        ),
    )
}

async fn launch_desktop(paths: &AppPaths) -> Result<ControlDescriptor, ToolError> {
    // A crashed instance can leave a descriptor behind. Do not accept that
    // stale descriptor immediately after spawning: wait until the new instance
    // replaces it, otherwise the retry would connect to the dead endpoint again.
    if desktop_is_already_running(paths) {
        return Err(already_running_without_control_error());
    }
    let previous = read_descriptor(&paths.data_dir).ok();
    let executable = resolve_desktop_executable().ok_or_else(|| {
        ToolError::new(
            "APP_LAUNCH_FAILED",
            "Could not locate the AIProxy desktop executable next to the MCP sidecar.",
        )
    })?;
    let mut command = Command::new(&executable);
    command
        .arg("--agent-launched")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|error| {
        ToolError::new(
            "APP_LAUNCH_FAILED",
            format!(
                "Could not launch AIProxy from {}: {error}",
                executable.display()
            ),
        )
    })?;

    let started = Instant::now();
    while started.elapsed() < APP_LAUNCH_TIMEOUT {
        if let Ok(descriptor) = read_descriptor(&paths.data_dir) {
            validate_descriptor(&descriptor)?;
            if descriptor_is_new(previous.as_ref(), &descriptor) {
                return Ok(descriptor);
            }
        }
        tokio::time::sleep(APP_LAUNCH_POLL_INTERVAL).await;
    }
    Err(ToolError::new(
        "APP_LAUNCH_FAILED",
        "AIProxy was launched, but its control channel did not become ready within 15 seconds. Check the app window for startup errors, then retry.",
    ))
}

fn desktop_is_already_running(paths: &AppPaths) -> bool {
    read_capture_status(&paths.data_dir).app_running
}

fn already_running_without_control_error() -> ToolError {
    ToolError::new(
        "CONTROL_UNAVAILABLE",
        "AIProxy is already running, but its Agent control channel is unavailable. Update AIProxy to the version that matches this MCP sidecar and restart the app before retrying a write tool.",
    )
}

fn descriptor_is_new(previous: Option<&ControlDescriptor>, current: &ControlDescriptor) -> bool {
    previous != Some(current)
}

fn resolve_desktop_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AIPROXY_DESKTOP_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let current = std::env::current_exe().ok()?;
    let directory = current.parent()?;
    let candidates = if cfg!(windows) {
        vec![directory.join("AIProxy.exe"), directory.join("aiproxy.exe")]
    } else {
        vec![directory.join("AIProxy"), directory.join("aiproxy")]
    };
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[allow(dead_code)]
fn tokens_match(descriptor: &ControlDescriptor, provided: &str) -> bool {
    token_matches(&descriptor.token, provided)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the unix control round-trip writes raw JSON lines; importing it
    // unconditionally made `-D warnings` fail on Windows, where that test is
    // compiled out.
    #[cfg(unix)]
    use aiproxy_agent_control::write_json_line;

    fn write_enabled_access_config(
        paths: &AppPaths,
        permissions: crate::config::AgentAccessPermissions,
    ) {
        crate::config::write_config(
            &paths.config_path,
            &AgentAccessConfig {
                enabled: true,
                permissions,
                ..AgentAccessConfig::default()
            },
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_round_trip_uses_the_descriptor_and_token() {
        use aiproxy_agent_control::{write_descriptor, ControlResponse, CONTROL_MAX_REQUEST_BYTES};
        use interprocess::local_socket::ListenerOptions;

        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory
            .path()
            .join("control.sock")
            .to_string_lossy()
            .into_owned();
        let name = endpoint
            .as_str()
            .to_fs_name::<interprocess::local_socket::GenericFilePath>()
            .unwrap();
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let test_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        write_descriptor(
            directory.path(),
            &ControlDescriptor {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                endpoint: endpoint.clone(),
                token: test_token.to_string(),
                pid: std::process::id(),
                app_version: "0.0.0".to_string(),
                started_at: "2026-10-26T00:00:00Z".to_string(),
            },
        )
        .unwrap();

        let server = std::thread::spawn(move || {
            let connection = listener.accept().unwrap();
            let mut reader = BufReader::new(&connection);
            let request_bytes = read_json_line(&mut reader, CONTROL_MAX_REQUEST_BYTES).unwrap();
            let request: ControlRequest = serde_json::from_slice(&request_bytes).unwrap();
            assert_eq!(request.protocol_version, CONTROL_PROTOCOL_VERSION);
            assert_eq!(request.token, test_token);
            assert_eq!(request.client_name.as_deref(), Some("codex"));
            assert_eq!(request.client_version.as_deref(), Some("1.0"));
            assert_eq!(request.operation, ControlOperation::GetStatus);
            write_json_line(
                &mut &connection,
                &ControlResponse::success(request.request_id, serde_json::json!({"ok": true})),
            )
            .unwrap();
        });

        let paths = AppPaths {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("aiproxy.db"),
            body_dir: directory.path().join("bodies"),
            config_path: directory.path().join("agent-access.json"),
            audit_path: directory.path().join("agent-audit.jsonl"),
        };
        write_enabled_access_config(&paths, Default::default());
        let value = call_control(
            &paths,
            ControlOperation::GetStatus,
            false,
            ControlCaller {
                name: "codex",
                version: "1.0",
            },
        )
        .await
        .unwrap();
        assert_eq!(value["ok"], true);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn write_control_does_not_launch_when_an_app_is_already_running_without_control() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(crate::status::STATUS_FILE_NAME),
            serde_json::json!({
                "appRunning": true,
                "capturing": false,
                "proxyPort": 8888,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            })
            .to_string(),
        )
        .unwrap();
        let paths = AppPaths {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("aiproxy.db"),
            body_dir: directory.path().join("bodies"),
            config_path: directory.path().join("agent-access.json"),
            audit_path: directory.path().join("agent-audit.jsonl"),
        };

        let error = call_control(
            &paths,
            ControlOperation::StartCapture(Default::default()),
            true,
            ControlCaller::default(),
        )
        .await
        .expect_err("a running app without control should not be launched again");
        assert_eq!(error.code, "CONTROL_UNAVAILABLE");
        assert!(error.message.contains("already running"));
        assert!(error.message.contains("Update AIProxy"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_errors_are_marked_as_remotely_audited() {
        use aiproxy_agent_control::{write_descriptor, ControlResponse, CONTROL_MAX_REQUEST_BYTES};
        use interprocess::local_socket::ListenerOptions;

        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory
            .path()
            .join("control.sock")
            .to_string_lossy()
            .into_owned();
        let name = endpoint
            .as_str()
            .to_fs_name::<interprocess::local_socket::GenericFilePath>()
            .unwrap();
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let test_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        write_descriptor(
            directory.path(),
            &ControlDescriptor {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                endpoint,
                token: test_token.to_string(),
                pid: std::process::id(),
                app_version: "0.0.0".to_string(),
                started_at: "2026-10-26T00:00:00Z".to_string(),
            },
        )
        .unwrap();

        let server = std::thread::spawn(move || {
            let connection = listener.accept().unwrap();
            let mut reader = BufReader::new(&connection);
            let request_bytes = read_json_line(&mut reader, CONTROL_MAX_REQUEST_BYTES).unwrap();
            let request: ControlRequest = serde_json::from_slice(&request_bytes).unwrap();
            write_json_line(
                &mut &connection,
                &ControlResponse::failure(
                    request.request_id,
                    ControlError::new("DB_BUSY", "database is busy"),
                ),
            )
            .unwrap();
        });

        let paths = AppPaths {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("aiproxy.db"),
            body_dir: directory.path().join("bodies"),
            config_path: directory.path().join("agent-access.json"),
            audit_path: directory.path().join("agent-audit.jsonl"),
        };
        write_enabled_access_config(
            &paths,
            crate::config::AgentAccessPermissions {
                delete_sessions: true,
                ..Default::default()
            },
        );
        let error = call_control(
            &paths,
            ControlOperation::ClearSessions,
            false,
            ControlCaller::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "DB_BUSY");
        assert!(error.audit_recorded_remotely);
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_lost_response_after_a_write_is_marked_as_remotely_audited() {
        use aiproxy_agent_control::{write_descriptor, CONTROL_MAX_REQUEST_BYTES};
        use interprocess::local_socket::ListenerOptions;

        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory
            .path()
            .join("control.sock")
            .to_string_lossy()
            .into_owned();
        let name = endpoint
            .as_str()
            .to_fs_name::<interprocess::local_socket::GenericFilePath>()
            .unwrap();
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let test_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        write_descriptor(
            directory.path(),
            &ControlDescriptor {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                endpoint,
                token: test_token.to_string(),
                pid: std::process::id(),
                app_version: "0.0.0".to_string(),
                started_at: "2026-10-26T00:00:00Z".to_string(),
            },
        )
        .unwrap();

        let server = std::thread::spawn(move || {
            let connection = listener.accept().unwrap();
            let mut reader = BufReader::new(&connection);
            read_json_line(&mut reader, CONTROL_MAX_REQUEST_BYTES).unwrap();
            // Close without a response, simulating an executed request whose
            // reply was lost.
        });

        let paths = AppPaths {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("aiproxy.db"),
            body_dir: directory.path().join("bodies"),
            config_path: directory.path().join("agent-access.json"),
            audit_path: directory.path().join("agent-audit.jsonl"),
        };
        write_enabled_access_config(
            &paths,
            crate::config::AgentAccessPermissions {
                delete_sessions: true,
                ..Default::default()
            },
        );
        let error = call_control(
            &paths,
            ControlOperation::ClearSessions,
            false,
            ControlCaller::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "CONTROL_UNAVAILABLE");
        assert!(error.audit_recorded_remotely);
        server.join().unwrap();
    }

    #[test]
    fn read_response_failures_are_not_marked_as_remotely_audited() {
        let error = ToolError::new("CONTROL_TIMEOUT", "probe timed out");
        assert!(!mark_lost_write_response(error, false).audit_recorded_remotely);
        let error = ToolError::new("CONTROL_TIMEOUT", "write timed out");
        assert!(mark_lost_write_response(error, true).audit_recorded_remotely);
    }

    fn descriptor(token: &str) -> ControlDescriptor {
        ControlDescriptor {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            endpoint: "aiproxy-control-test".to_string(),
            token: token.to_string(),
            pid: 1,
            app_version: "0.0.0".to_string(),
            started_at: "2026-10-26T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn launch_waits_for_a_replaced_descriptor() {
        let old = descriptor("old-token");
        assert!(!descriptor_is_new(Some(&old), &old));

        let mut replacement = old.clone();
        replacement.token = "new-token".to_string();
        replacement.pid = 2;
        assert!(descriptor_is_new(Some(&old), &replacement));
        assert!(descriptor_is_new(None, &replacement));
    }

    #[test]
    fn control_io_timeouts_are_not_retryable_unavailable_errors() {
        let timeout = std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out");
        let timeout = control_io_error("Read AIProxy control response", timeout, 60);
        assert_eq!(timeout.code, "CONTROL_TIMEOUT");
        assert!(!timeout.retryable);

        let disconnected = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed");
        let disconnected = control_io_error("Read AIProxy control response", disconnected, 60);
        assert_eq!(disconnected.code, "CONTROL_UNAVAILABLE");
        assert!(!disconnected.retryable);

        let refused = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        let refused =
            control_io_error("Connect to the AIProxy control channel", refused, 60).retryable(true);
        assert_eq!(refused.code, "CONTROL_UNAVAILABLE");
        assert!(refused.retryable);
    }
}
