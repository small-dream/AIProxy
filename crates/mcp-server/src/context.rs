use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use aiproxy_db::body_store::BodyStore;
use aiproxy_db::connection::{inspect_schema, open_read_only_database, SchemaCapabilities};
use aiproxy_db::DbError;
use serde_json::{json, Value};

use crate::audit::{is_agent_control_tool, AuditEntry, AuditLog};
use crate::config::{
    read_config, AgentAccessConfig, AppPaths, ConfigReadError, DEFAULT_MAX_BODY_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_MAX_SESSIONS,
};
use crate::protocol::ToolError;
use crate::status::read_capture_status;

pub const TOOL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct AppContext {
    pub paths: AppPaths,
    pub body_store: BodyStore,
    pub audit: Arc<AuditLog>,
    pub capabilities: Option<SchemaCapabilities>,
    pub startup_error: Option<ToolError>,
    pub sidecar_version: String,
}

pub struct AuditRecord<'a> {
    pub client_name: &'a str,
    pub client_version: &'a str,
    pub tool: &'a str,
    pub action_summary: Option<&'a str>,
    pub outcome: &'a str,
    pub returned_bytes: Option<usize>,
    pub redacted: bool,
    pub truncated: bool,
    pub error_code: Option<&'a str>,
}

/// Metadata placed on every tool result so an Agent can tell the user how old
/// the data is and whether capture is still running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Freshness {
    pub latest_session_at: Option<String>,
    pub capture_status: &'static str,
    pub capture_updated_at: Option<String>,
}

impl AppContext {
    pub fn new(paths: AppPaths) -> Self {
        let (capabilities, startup_error) = match open_read_only_database(&paths.db_path) {
            Ok(connection) => match inspect_schema(&connection) {
                Ok(capabilities) if capabilities.core_sessions => (Some(capabilities), None),
                Ok(_) => (
                    None,
                    Some(ToolError::new(
                        "SCHEMA_INCOMPATIBLE",
                        "The AIProxy database is missing required session tables or columns. Open AIProxy once so it can run migrations, then retry.",
                    )),
                ),
                Err(error) => (None, Some(crate::protocol::map_db_error(error, false))),
            },
            Err(DbError::Connection(message)) if message.contains("does not exist") => (
                None,
                Some(ToolError::new("AI_PROXY_NOT_INITIALIZED", message)),
            ),
            Err(error) => (None, Some(crate::protocol::map_db_error(error, false))),
        };

        Self {
            body_store: BodyStore::new(paths.body_dir.clone()),
            audit: Arc::new(AuditLog::new(paths.audit_path.clone())),
            paths,
            capabilities,
            startup_error,
            sidecar_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn config(&self) -> Result<AgentAccessConfig, ToolError> {
        let config = read_config(&self.paths.config_path).map_err(|error| match error {
            ConfigReadError::Missing => ToolError::disabled(),
            ConfigReadError::Invalid(message) => ToolError::new(
                "AGENT_ACCESS_DISABLED",
                format!("Agent Access configuration is invalid: {message}"),
            ),
        })?;
        if !config.enabled {
            return Err(ToolError::disabled());
        }
        Ok(config)
    }

    pub fn config_for_doctor(&self) -> Result<AgentAccessConfig, ConfigReadError> {
        read_config(&self.paths.config_path)
    }

    pub fn freshness(&self) -> Freshness {
        let latest_session_at = if self.startup_error.is_some() {
            None
        } else {
            match open_read_only_database(&self.paths.db_path) {
                Ok(connection) => connection
                    .query_row("SELECT MAX(started_at) FROM session_summaries", [], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .unwrap_or_else(|error| {
                        tracing::warn!(
                            component = "mcp.freshness",
                            event = "latest_session_query_failed",
                            error = %error,
                            "latest_session_query_failed"
                        );
                        None
                    }),
                Err(error) => {
                    tracing::warn!(
                        component = "mcp.freshness",
                        event = "freshness_database_open_failed",
                        error = %error,
                        "freshness_database_open_failed"
                    );
                    None
                }
            }
        };
        let capture = read_capture_status(&self.paths.data_dir);
        Freshness {
            latest_session_at,
            capture_status: capture.status,
            capture_updated_at: capture.updated_at,
        }
    }

    pub async fn with_db<T, F>(&self, operation: F) -> Result<T, ToolError>
    where
        T: Send + 'static,
        F: FnOnce(&aiproxy_db::rusqlite::Connection) -> Result<T, DbError> + Send + 'static,
    {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }
        let db_path = self.paths.db_path.clone();
        let task = tokio::task::spawn_blocking(move || {
            let connection = open_read_only_database(&db_path)?;
            operation(&connection)
        });
        match tokio::time::timeout(TOOL_TIMEOUT, task).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(crate::protocol::map_db_error(error, false)),
            Ok(Err(error)) => Err(ToolError::new(
                "INTERNAL_ERROR",
                format!("database worker failed: {error}"),
            )),
            Err(_) => Err(ToolError::new(
                "TOOL_TIMEOUT",
                "The tool call timed out. Retry with a narrower query.",
            )
            .retryable(true)),
        }
    }

    pub fn max_sessions(&self) -> usize {
        self.config()
            .map(|config| config.limits.max_sessions)
            .unwrap_or(DEFAULT_MAX_SESSIONS)
    }

    pub fn max_body_bytes(&self) -> usize {
        self.config()
            .map(|config| config.limits.max_body_bytes)
            .unwrap_or(DEFAULT_MAX_BODY_BYTES)
    }

    pub fn max_response_bytes(&self) -> usize {
        self.config()
            .map(|config| config.limits.max_response_bytes)
            .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES)
    }

    pub fn record_audit(&self, started: Instant, record: AuditRecord<'_>) -> bool {
        let entry = AuditEntry {
            timestamp: chrono::Utc::now().to_rfc3339(),
            client_name: record.client_name,
            client_version: record.client_version,
            tool: record.tool,
            action_summary: record.action_summary.map(str::to_string),
            agent_control: is_agent_control_tool(record.tool),
            outcome: record.outcome,
            duration_ms: started.elapsed().as_millis() as u64,
            returned_bytes: record.returned_bytes,
            redacted: record.redacted,
            truncated: record.truncated,
            error_code: record.error_code,
        };
        self.audit.append(&entry).is_ok()
    }

    pub fn doctor_result(&self) -> Value {
        let config = self.config_for_doctor();
        let database_readable = self.startup_error.is_none();
        let config_readable = config.is_ok();
        let capabilities = self.capabilities;
        let schema_compatible = capabilities.is_some_and(|value| {
            value.core_sessions && value.session_details && value.body_references
        });
        let enabled = config.as_ref().is_ok_and(|value| value.enabled);
        let permissions = config.as_ref().ok().map(|value| {
            json!({
                "readSessions": value.permissions.read_sessions,
                "readBodies": value.permissions.read_bodies,
                "readRawBodies": value.permissions.read_raw_bodies,
                "readWebSocket": value.permissions.read_web_socket,
                "exportSnapshots": value.permissions.export_snapshots,
                "controlCapture": value.permissions.control_capture,
                "controlSystemProxy": value.permissions.control_system_proxy,
                "manageCertificates": value.permissions.manage_certificates,
                "deleteSessions": value.permissions.delete_sessions,
                "sendRequests": value.permissions.send_requests,
                "manageRules": value.permissions.manage_rules,
            })
        });
        let mut issues: Vec<Value> = Vec::new();
        if !database_readable {
            issues.push(json!({
                "code": "DATABASE_UNREADABLE",
                "message": "The AIProxy database could not be opened in read-only mode.",
            }));
        }
        if let Some(error) = &self.startup_error {
            issues.push(json!({
                "code": error.code,
                "message": error.message,
            }));
        } else if !schema_compatible {
            issues.push(json!({
                "code": "SCHEMA_INCOMPATIBLE",
                "message": "The AIProxy database schema is out of date. Open AIProxy once so it can run migrations.",
            }));
        }
        if capabilities.is_some_and(|value| !value.websocket_messages) {
            issues.push(json!({
                "code": "WEBSOCKET_SCHEMA_INCOMPATIBLE",
                "message": "WebSocket message reading is unavailable until AIProxy migrates the database.",
            }));
        }
        if capabilities.is_some_and(|value| !value.workspaces) {
            issues.push(json!({
                "code": "WORKSPACE_SCHEMA_INCOMPATIBLE",
                "message": "Workspace listing is unavailable until AIProxy migrates the database.",
            }));
        }
        match &config {
            Ok(value) if !value.enabled => issues.push(json!({
                "code": "AGENT_ACCESS_DISABLED",
                "message": "Agent Access is disabled. Enable it in AIProxy Settings > Agent Access.",
            })),
            Err(error) => issues.push(json!({
                "code": "AGENT_ACCESS_CONFIG_INVALID",
                "message": error.message(),
            })),
            _ => {}
        }

        let ok = database_readable && config_readable && enabled && schema_compatible;
        let mut body = json!({
            "ok": ok,
            "data": {
                "sidecarVersion": self.sidecar_version,
                "dataDir": self.paths.data_dir.display().to_string(),
                "databasePath": self.paths.db_path.display().to_string(),
                "databaseReadable": database_readable,
                "configReadable": config_readable,
                "agentAccessEnabled": enabled,
                "schemaCompatible": schema_compatible,
                "capabilities": capabilities.map(capabilities_json),
                "permissions": permissions,
                "availableTools": available_tools(),
            },
        });
        if let Some(error) = &self.startup_error {
            body["error"] = json!({ "code": error.code, "message": error.message });
        }
        if let Err(error) = &config {
            body["configError"] = json!(error.message());
        }
        body["issues"] = json!(issues);
        body
    }
}

fn capabilities_json(capabilities: SchemaCapabilities) -> Value {
    json!({
        "coreSessions": capabilities.core_sessions,
        "sessionDetails": capabilities.session_details,
        "bodyReferences": capabilities.body_references,
        "webSocketMessages": capabilities.websocket_messages,
        "ruleTraces": capabilities.rule_traces,
        "workspaces": capabilities.workspaces,
    })
}

pub fn available_tools() -> Vec<&'static str> {
    vec![
        "list_workspaces",
        "search_sessions",
        "wait_for_sessions",
        "get_session",
        "export_session_as_curl",
        "get_session_body",
        "get_session_fields",
        "get_websocket_messages",
        "get_insights",
        "compare_sessions",
        "get_app_status",
        "diagnose_ai_proxy_issue",
        "configure_workspace",
        "start_capture",
        "stop_capture",
        "set_system_proxy",
        "generate_certificate",
        "open_certificate_installer",
        "remove_certificate_trust",
        "clear_sessions",
        "delete_sessions",
        "replay_session",
        "create_agent_rule",
        "list_agent_rules",
        "remove_agent_rules",
    ]
}

pub fn config_is_readable(path: &Path) -> bool {
    path.is_file()
}
