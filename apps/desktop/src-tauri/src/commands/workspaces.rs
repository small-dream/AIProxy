use super::common::*;

#[tauri::command]
pub fn list_workspaces(state: State<'_, Arc<AppState>>) -> Vec<WorkspaceData> {
    state.read_workspace_manager().list()
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
) -> WorkspaceData {
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
            .expect("db mutex should not be poisoned");
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
            tracing::error!(
                component = "desktop.commands",
                event = "create_workspace_db_failed",
                error = %error,
                "create_workspace_db_failed"
            );
        }
    }

    tracing::info!(
        component = "desktop.commands",
        event = "create_workspace_succeeded",
        workspace_id = %workspace.id,
        "create_workspace_succeeded"
    );

    workspace
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
        .ok_or_else(|| format!("workspace {} not found", input.workspace_id))?;

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

    let workspace = state.read_workspace_manager().update(
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
            .expect("db mutex should not be poisoned");
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            input.http2_enabled,
            &workspace.updated_at,
        ) {
            tracing::error!(
                component = "desktop.commands",
                event = "update_workspace_db_failed",
                error = %error,
                "update_workspace_db_failed"
            );
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
