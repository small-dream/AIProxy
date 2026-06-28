use super::common::*;

#[tauri::command]
pub fn list_workspaces(state: State<'_, Arc<AppState>>) -> Result<Vec<WorkspaceData>, String> {
    Ok(state.read_workspace_manager().list())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub name: String,
    pub proxy_port: u16,
    pub ssl_enabled: Option<bool>,
    pub http2_enabled: Option<bool>,
}

#[tauri::command]
pub fn create_workspace(
    input: CreateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    let ssl_enabled = input.ssl_enabled.unwrap_or(true);
    let http2_enabled = input.http2_enabled.unwrap_or(true);

    tracing::info!(
        component = "desktop.commands",
        event = "create_workspace_requested",
        name = %input.name,
        port = %input.proxy_port,
        ssl_enabled = %ssl_enabled,
        http2_enabled = %http2_enabled,
        "create_workspace_requested"
    );

    let workspace = state.read_workspace_manager().create(
        input.name,
        input.proxy_port,
        ssl_enabled,
        http2_enabled,
    );

    // Persist to DB
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let row = aiproxy_db::workspaces::WorkspaceRow {
            id: workspace.id.clone(),
            name: workspace.name.clone(),
            proxy_port: workspace.proxy_port,
            ssl_enabled: workspace.ssl_enabled,
            http2_enabled: workspace.http2_enabled,
            system_proxy_enabled: workspace.system_proxy_enabled,
            storage_path: workspace.storage_path.clone(),
            created_at: workspace.created_at.clone(),
            updated_at: workspace.updated_at.clone(),
        };
        if let Err(error) = aiproxy_db::workspaces::upsert_workspace(&conn, &row) {
            // Roll back the in-memory create so we never advertise a workspace
            // that won't survive a restart, then surface the error to the UI.
            state.read_workspace_manager().remove(&workspace.id);
            tracing::error!(
                component = "desktop.commands",
                event = "create_workspace_db_failed",
                workspace_id = %workspace.id,
                error = %error,
                "create_workspace_db_failed"
            );
            return Err(app_error(
                ERR_INTERNAL,
                format!("create_workspace: {error}"),
            ));
        }
    }

    tracing::info!(
        component = "desktop.commands",
        event = "create_workspace_succeeded",
        workspace_id = %workspace.id,
        "create_workspace_succeeded"
    );

    Ok(workspace)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn load_workspace(
    input: LoadWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    tracing::info!(
        component = "desktop.commands",
        event = "load_workspace_requested",
        workspace_id = %input.workspace_id,
        "load_workspace_requested"
    );

    let workspace = state
        .read_workspace_manager()
        .load(&input.workspace_id)
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                format!("Workspace {} was not found.", input.workspace_id),
            )
        })?;

    tracing::info!(
        component = "desktop.commands",
        event = "load_workspace_succeeded",
        workspace_id = %workspace.id,
        name = %workspace.name,
        "load_workspace_succeeded"
    );

    Ok(workspace)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    pub workspace_id: String,
    pub name: Option<String>,
    pub proxy_port: Option<u16>,
    pub ssl_enabled: Option<bool>,
    pub http2_enabled: Option<bool>,
}

#[tauri::command]
pub fn update_workspace(
    input: UpdateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    tracing::info!(
        component = "desktop.commands",
        event = "update_workspace_requested",
        workspace_id = %input.workspace_id,
        "update_workspace_requested"
    );

    // Capture the pre-update snapshot so we can roll back the in-memory state
    // if the DB write fails (otherwise the UI would show the edit but the
    // workspace would revert to its old value on the next restart).
    let manager = state.read_workspace_manager();
    let before = manager.load(&input.workspace_id);

    let workspace = manager.update(
        &input.workspace_id,
        input.name.clone(),
        input.proxy_port,
        input.ssl_enabled,
        input.http2_enabled,
    )?;

    // Persist to DB
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            input.http2_enabled,
            &workspace.updated_at,
        ) {
            // Restore the prior in-memory state so memory matches the DB.
            if let Some(previous) = before.as_ref() {
                let _ = manager.update(
                    &previous.id,
                    Some(previous.name.clone()),
                    Some(previous.proxy_port),
                    Some(previous.ssl_enabled),
                    Some(previous.http2_enabled),
                );
            }
            tracing::error!(
                component = "desktop.commands",
                event = "update_workspace_db_failed",
                workspace_id = %input.workspace_id,
                error = %error,
                "update_workspace_db_failed"
            );
            return Err(app_error(
                ERR_INTERNAL,
                format!("update_workspace: {error}"),
            ));
        }
    }

    tracing::info!(
        component = "desktop.commands",
        event = "update_workspace_succeeded",
        workspace_id = %workspace.id,
        "update_workspace_succeeded"
    );

    Ok(workspace)
}
