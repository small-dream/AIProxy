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
}

#[tauri::command]
pub fn create_workspace(
    input: CreateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> WorkspaceData {
    let ssl_enabled = input.ssl_enabled.unwrap_or(true);

    log_info(
        "desktop.commands",
        "create_workspace_requested",
        &[
            ("name", input.name.clone()),
            ("port", input.proxy_port.to_string()),
            ("ssl_enabled", ssl_enabled.to_string()),
        ],
    );

    let workspace = state
        .read_workspace_manager()
        .create(input.name, input.proxy_port, ssl_enabled);

    // Persist to DB
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        let row = aiproxy_db::workspaces::WorkspaceRow {
            id: workspace.id.clone(),
            name: workspace.name.clone(),
            proxy_port: workspace.proxy_port,
            ssl_enabled: workspace.ssl_enabled,
            system_proxy_enabled: workspace.system_proxy_enabled,
            storage_path: workspace.storage_path.clone(),
            created_at: workspace.created_at.clone(),
            updated_at: workspace.updated_at.clone(),
        };
        if let Err(error) = aiproxy_db::workspaces::upsert_workspace(&conn, &row) {
            log_error("desktop.commands", "create_workspace_db_failed", &[("error", error)]);
        }
    }

    log_info(
        "desktop.commands",
        "create_workspace_succeeded",
        &[("workspace_id", workspace.id.clone())],
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
    log_info(
        "desktop.commands",
        "load_workspace_requested",
        &[("workspace_id", input.workspace_id.clone())],
    );

    let workspace = state
        .read_workspace_manager()
        .load(&input.workspace_id)
        .ok_or_else(|| format!("workspace {} not found", input.workspace_id))?;

    log_info(
        "desktop.commands",
        "load_workspace_succeeded",
        &[
            ("workspace_id", workspace.id.clone()),
            ("name", workspace.name.clone()),
        ],
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
}

#[tauri::command]
pub fn update_workspace(
    input: UpdateWorkspaceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceData, String> {
    log_info(
        "desktop.commands",
        "update_workspace_requested",
        &[("workspace_id", input.workspace_id.clone())],
    );

    let workspace = state.read_workspace_manager().update(
        &input.workspace_id,
        input.name.clone(),
        input.proxy_port,
        input.ssl_enabled,
    )?;

    // Persist to DB
    {
        let conn = state.read_db_connection().lock().expect("db mutex should not be poisoned");
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            &workspace.updated_at,
        ) {
            log_error("desktop.commands", "update_workspace_db_failed", &[("error", error)]);
        }
    }

    log_info(
        "desktop.commands",
        "update_workspace_succeeded",
        &[("workspace_id", workspace.id.clone())],
    );

    Ok(workspace)
}
