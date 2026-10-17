pub mod body;
pub mod compare;
pub mod insights;
pub mod sessions;
pub mod websocket;
pub mod workspaces;

use std::time::Instant;

use rmcp::model::CallToolResult;
use rmcp::service::RequestContext;
use rmcp::RoleServer;
use serde_json::Value;

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
    let (client_name, client_version) = client_identity(context);
    let returned_bytes = serde_json::to_vec(&data).map(|bytes| bytes.len()).ok();
    let audit_ok = state.record_audit(
        started,
        AuditRecord {
            client_name: &client_name,
            client_version: &client_version,
            tool,
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
    let (client_name, client_version) = client_identity(context);
    let _ = state.record_audit(
        started,
        AuditRecord {
            client_name: &client_name,
            client_version: &client_version,
            tool,
            outcome: "error",
            returned_bytes: None,
            redacted: true,
            truncated: false,
            error_code: Some(error.code),
        },
    );
    error_result(error)
}
