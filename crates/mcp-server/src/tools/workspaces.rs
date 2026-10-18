use aiproxy_db::rusqlite::OptionalExtension;
use aiproxy_db::workspaces::load_all_workspaces;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};

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
            "Workspace reading is disabled in Agent Access.",
        ));
    }
    if !state
        .capabilities
        .is_some_and(|capabilities| capabilities.workspaces)
    {
        return Err(ToolError::new(
            "SCHEMA_INCOMPATIBLE",
            "The workspaces table is not available in this database.",
        ));
    }

    let (workspaces, stats) = state
        .with_db(|connection| {
            let workspaces = load_all_workspaces(connection)?;
            let stats = load_session_stats(connection)?;
            Ok((workspaces, stats))
        })
        .await?;
    let items = workspaces
        .into_iter()
        .map(|workspace| {
            json!({
                "workspaceId": workspace.id,
                "name": workspace.name,
                "proxyPort": workspace.proxy_port,
                "sslEnabled": workspace.ssl_enabled,
                "http2Enabled": workspace.http2_enabled,
                "systemProxyEnabled": workspace.system_proxy_enabled,
                "verifyUpstreamTls": workspace.verify_upstream_tls,
                "runtimeStatus": "unknown",
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
