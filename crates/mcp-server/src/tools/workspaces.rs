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

    let workspaces = state.with_db(load_all_workspaces).await?;
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
            })
        })
        .collect::<Vec<_>>();
    Ok((json!({ "items": items }), ToolMeta::new(false, false, None)))
}
