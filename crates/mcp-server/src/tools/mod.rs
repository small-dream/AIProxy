pub mod agent;
pub mod body;
pub(crate) mod body_stream;
pub mod compare;
pub mod control;
pub mod curl;
pub mod diagnostics;
pub mod insights;
pub mod sessions;
pub mod websocket;
pub mod workspaces;

use std::time::Instant;

use rmcp::model::CallToolResult;
use rmcp::service::RequestContext;
use rmcp::RoleServer;
use serde_json::Value;

use crate::audit::is_agent_control_tool;
use crate::context::{AppContext, AuditRecord};
use crate::protocol::{error_result, success_result, ToolError, ToolMeta};

pub fn client_identity(context: &RequestContext<RoleServer>) -> (String, String) {
    context
        .client_info()
        .map(|info| (info.name, info.version))
        .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()))
}

pub fn finish_success(
    state: &AppContext,
    context: &RequestContext<RoleServer>,
    tool: &str,
    data: Value,
    meta: ToolMeta,
    started: Instant,
    sensitive: bool,
) -> CallToolResult {
    finish_success_with_summary(state, context, tool, None, data, meta, started, sensitive)
}

#[allow(clippy::too_many_arguments)]
pub fn finish_success_with_summary(
    state: &AppContext,
    context: &RequestContext<RoleServer>,
    tool: &str,
    action_summary: Option<&str>,
    data: Value,
    meta: ToolMeta,
    started: Instant,
    sensitive: bool,
) -> CallToolResult {
    let (client_name, client_version) = client_identity(context);
    let returned_bytes = serde_json::to_vec(&data).map(|bytes| bytes.len()).ok();
    if let Some(result_bytes) = returned_bytes {
        let max_response_bytes = state.max_response_bytes();
        if result_bytes > max_response_bytes {
            return finish_error_with_summary(
                state,
                context,
                tool,
                action_summary,
                ToolError::new(
                    "RESULT_TOO_LARGE",
                    "The tool result exceeds the configured Agent Access response limit. Narrow the query or request fewer fields.",
                )
                .with_details(serde_json::json!({
                    "resultBytes": result_bytes,
                    "maxResponseBytes": max_response_bytes,
                })),
                started,
            );
        }
    }
    let meta = meta.with_freshness(state.freshness());
    // Desktop owns action auditing for control tools: it sees every local IPC
    // request, including direct calls that bypass this sidecar. Keep sidecar
    // auditing for read tools and for non-control failures.
    let audit_ok = is_agent_control_tool(tool)
        || state.record_audit(
            started,
            AuditRecord {
                client_name: &client_name,
                client_version: &client_version,
                tool,
                action_summary,
                outcome: "success",
                returned_bytes,
                redacted: meta.redacted,
                truncated: meta.truncated,
                error_code: None,
            },
        );
    if sensitive && !audit_ok {
        return error_result(ToolError::new(
            "AUDIT_UNAVAILABLE",
            "The audit log is not writable. Sensitive Agent Access tools are disabled.",
        ));
    }
    success_result(data, meta.with_audit_degraded(!audit_ok), started)
}

pub fn finish_error(
    state: &AppContext,
    context: &RequestContext<RoleServer>,
    tool: &str,
    error: ToolError,
    started: Instant,
) -> CallToolResult {
    finish_error_with_summary(state, context, tool, None, error, started)
}

pub fn finish_error_with_summary(
    state: &AppContext,
    context: &RequestContext<RoleServer>,
    tool: &str,
    action_summary: Option<&str>,
    error: ToolError,
    started: Instant,
) -> CallToolResult {
    let (client_name, client_version) = client_identity(context);
    if !is_agent_control_tool(tool) || !error.audit_recorded_remotely {
        let _ = state.record_audit(
            started,
            AuditRecord {
                client_name: &client_name,
                client_version: &client_version,
                tool,
                action_summary,
                outcome: "error",
                returned_bytes: None,
                redacted: true,
                truncated: false,
                error_code: Some(error.code.as_str()),
            },
        );
    }
    error_result(error)
}
