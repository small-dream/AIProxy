use aiproxy_db::rusqlite::OptionalExtension;
use aiproxy_db::workspaces::load_all_workspaces;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::control_client::try_control;
use crate::protocol::{ToolError, ToolMeta};
use aiproxy_agent_control::ControlOperation;

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListWorkspacesRequest {}

pub async fn list_workspaces(
    state: &AppContext,
    _request: ListWorkspacesRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Workspace reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    if !state
        .capabilities
        .is_some_and(|capabilities| capabilities.workspaces)
    {
        return Err(ToolError::new(
            "SCHEMA_INCOMPATIBLE",
            "Workspace listing is unavailable until AIProxy migrates the database. Open AIProxy once, then retry.",
        ));
    }

    let (workspaces, stats) = state
        .with_db(|connection| {
            let workspaces = load_all_workspaces(connection)?;
            let stats = load_session_stats(connection)?;
            Ok((workspaces, stats))
        })
        .await?;
    let runtime = try_control(&state.paths, ControlOperation::GetStatus)
        .await
        .ok();
    let active_workspace = runtime
        .as_ref()
        .and_then(|value| value.get("activeWorkspaceId"))
        .and_then(Value::as_str);
    let runtime_capture_status = runtime
        .as_ref()
        .and_then(|value| value.get("capture"))
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let items = workspaces
        .into_iter()
        .map(|workspace| {
            let runtime_status = if active_workspace == Some(workspace.id.as_str()) {
                runtime_capture_status.unwrap_or("unknown")
            } else {
                "unknown"
            };
            json!({
                "workspaceId": workspace.id,
                "name": workspace.name,
                "proxyPort": workspace.proxy_port,
                "sslEnabled": workspace.ssl_enabled,
                "http2Enabled": workspace.http2_enabled,
                "systemProxyEnabled": workspace.system_proxy_enabled,
                "verifyUpstreamTls": workspace.verify_upstream_tls,
                "runtimeStatus": runtime_status,
                "sessionScope": "global",
                "sessionCount": stats.session_count,
                "latestSessionAt": stats.latest_session_at,
                "latestSessionId": stats.latest_session_id,
            })
        })
        .collect::<Vec<_>>();
    Ok((json!({ "items": items }), ToolMeta::new(false, false, None)))
}

struct SessionStats {
    session_count: i64,
    latest_session_at: Option<String>,
    latest_session_id: Option<String>,
}

fn load_session_stats(
    connection: &aiproxy_db::rusqlite::Connection,
) -> Result<SessionStats, aiproxy_db::DbError> {
    let session_count = connection
        .query_row("SELECT COUNT(*) FROM session_summaries", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| aiproxy_db::DbError::query("count workspace sessions", error))?;
    let latest = connection
        .query_row(
            "SELECT id, started_at FROM session_summaries
             ORDER BY started_at DESC, id DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| aiproxy_db::DbError::query("load latest session", error))?;
    Ok(SessionStats {
        session_count,
        latest_session_at: latest.as_ref().map(|(_, started_at)| started_at.clone()),
        latest_session_id: latest.map(|(id, _)| id),
    })
}
