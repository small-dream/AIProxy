use aiproxy_db::DbError;
use chrono::Utc;
use rmcp::model::CallToolResult;
use serde_json::{json, Value};

use crate::context::Freshness;

pub const MCP_TOOL_SCHEMA_VERSION: &str = "2.2";

#[derive(Debug, Clone, Default)]
pub struct ToolMeta {
    pub truncated: bool,
    pub truncated_reason: Option<String>,
    pub redacted: bool,
    pub next_cursor: Option<String>,
    pub audit_degraded: bool,
    pub latest_session_at: Option<String>,
    pub capture_status: Option<&'static str>,
    pub capture_updated_at: Option<String>,
}

impl ToolMeta {
    pub fn new(truncated: bool, redacted: bool, next_cursor: Option<String>) -> Self {
        Self {
            truncated,
            redacted,
            next_cursor,
            ..Self::default()
        }
    }

    pub fn with_truncated_reason(mut self, reason: impl Into<String>) -> Self {
        self.truncated = true;
        self.truncated_reason = Some(reason.into());
        self
    }

    pub fn with_audit_degraded(mut self, degraded: bool) -> Self {
        self.audit_degraded = degraded;
        self
    }

    pub fn with_freshness(mut self, freshness: Freshness) -> Self {
        self.latest_session_at = freshness.latest_session_at;
        self.capture_status = Some(freshness.capture_status);
        self.capture_updated_at = freshness.capture_updated_at;
        self
    }

    fn to_json(&self, started: std::time::Instant) -> Value {
        json!({
            "schemaVersion": MCP_TOOL_SCHEMA_VERSION,
            "dataFreshness": "persisted",
            "latestSessionAt": self.latest_session_at,
            "captureStatus": self.capture_status.unwrap_or("unknown"),
            "captureUpdatedAt": self.capture_updated_at,
            "truncated": self.truncated,
            "truncatedReason": self.truncated_reason,
            "redacted": self.redacted,
            "nextCursor": self.next_cursor,
            "tookMs": started.elapsed().as_millis() as u64,
            "readAt": Utc::now().to_rfc3339(),
            "auditDegraded": self.audit_degraded,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new("PERMISSION_DENIED", message)
    }

    pub fn disabled() -> Self {
        Self::new(
            "AGENT_ACCESS_DISABLED",
            "Agent Access is disabled. Enable it in AIProxy Settings > Agent Access.",
        )
    }
}

pub fn success_result(data: Value, meta: ToolMeta, started: std::time::Instant) -> CallToolResult {
    CallToolResult::structured(json!({
        "ok": true,
        "data": data,
        "meta": meta.to_json(started),
    }))
}

pub fn error_result(error: ToolError) -> CallToolResult {
    let mut error_json = json!({
        "code": error.code,
        "message": error.message,
        "retryable": error.retryable,
    });
    if let Some(details) = error.details {
        error_json["details"] = details;
    }
    CallToolResult::structured_error(json!({
        "ok": false,
        "error": error_json,
    }))
}

pub fn map_db_error(error: DbError, body_context: bool) -> ToolError {
    match error {
        DbError::Connection(message) => {
            if message.contains("does not exist") {
                ToolError::new(
                    "AI_PROXY_NOT_INITIALIZED",
                    "No AIProxy database was found. Open AIProxy and capture some traffic first.",
                )
                .with_details(json!({ "context": message }))
            } else {
                ToolError::new("INTERNAL_ERROR", message)
            }
        }
        DbError::Validation(message) => {
            if message.to_lowercase().contains("cursor") {
                ToolError::new("CURSOR_INVALID", message)
            } else {
                ToolError::new("INVALID_ARGUMENT", message)
            }
        }
        DbError::NotFound { entity, id } => ToolError::new(
            if entity == "session" {
                "SESSION_NOT_FOUND"
            } else {
                "INTERNAL_ERROR"
            },
            format!("{entity} not found: {id}"),
        ),
        DbError::Io(error) => ToolError::new(
            if body_context {
                "BODY_NOT_FOUND"
            } else {
                "INTERNAL_ERROR"
            },
            error.to_string(),
        ),
        DbError::QueryFailed { context, source } => match source.sqlite_error_code() {
            Some(aiproxy_db::rusqlite::ErrorCode::DatabaseBusy)
            | Some(aiproxy_db::rusqlite::ErrorCode::DatabaseLocked) => ToolError::new(
                "DB_BUSY",
                "The AIProxy database is busy. Retry the request.",
            )
            .retryable(true),
            _ if source.to_string().contains("no such table")
                || source.to_string().contains("no such column") =>
            {
                ToolError::new(
                    "SCHEMA_INCOMPATIBLE",
                    "The AIProxy database schema is out of date. Open AIProxy once so it can run migrations, then retry.",
                )
                .with_details(json!({ "context": context }))
            }
            _ => ToolError::new(
                "INTERNAL_ERROR",
                "The AIProxy database query failed. Open AIProxy once, then retry the tool call.",
            )
            .with_details(json!({ "context": context })),
        },
        other => ToolError::new("INTERNAL_ERROR", other.to_string()),
    }
}
