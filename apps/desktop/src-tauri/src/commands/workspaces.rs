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
pub async fn create_workspace(
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

    let manager = state.read_workspace_manager();
    let workspace = manager.create(input.name, input.proxy_port, ssl_enabled, http2_enabled);

    // Persist to DB on the blocking pool. Only the DB write (and the connection
    // lock) runs inside the closure; the in-memory `create` above and the
    // rollback below stay on the async task so we never block the IPC thread on
    // SQLite I/O.
    let app_state = Arc::clone(state.inner());
    let workspace_for_db = workspace.clone();
    let db_result = run_blocking_command("create_workspace", move || {
        let conn = app_state.read_db_connection();
        let conn_guard = conn
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let row = aiproxy_db::workspaces::WorkspaceRow {
            id: workspace_for_db.id.clone(),
            name: workspace_for_db.name.clone(),
            proxy_port: workspace_for_db.proxy_port,
            ssl_enabled: workspace_for_db.ssl_enabled,
            http2_enabled: workspace_for_db.http2_enabled,
            system_proxy_enabled: workspace_for_db.system_proxy_enabled,
            verify_upstream_tls: workspace_for_db.verify_upstream_tls,
            // Serialize the IPC-facing Vec<String> into the JSON-encoded TEXT
            // column the DB row expects.
            tls_verify_hosts: serde_json::to_string(&workspace_for_db.tls_verify_hosts)
                .unwrap_or_else(|_| "[]".to_string()),
            storage_path: workspace_for_db.storage_path.clone(),
            created_at: workspace_for_db.created_at.clone(),
            updated_at: workspace_for_db.updated_at.clone(),
        };
        if let Err(error) = aiproxy_db::workspaces::upsert_workspace(&conn_guard, &row) {
            tracing::error!(
                component = "desktop.commands",
                event = "create_workspace_db_failed",
                workspace_id = %workspace_for_db.id,
                error = %error,
                "create_workspace_db_failed"
            );
            return Err(app_error(
                ERR_INTERNAL,
                format!("create_workspace: {error}"),
            ));
        }
        Ok(())
    })
    .await;

    match db_result {
        Ok(()) => {
            tracing::info!(
                component = "desktop.commands",
                event = "create_workspace_succeeded",
                workspace_id = %workspace.id,
                "create_workspace_succeeded"
            );
            Ok(workspace)
        }
        Err(error) => {
            // Roll back the in-memory create so we never advertise a workspace
            // that won't survive a restart, then surface the error to the UI.
            manager.remove(&workspace.id);
            Err(error)
        }
    }
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
    /// H3: enable/disable upstream TLS certificate verification for new
    /// connections in this workspace. None ⇒ leave unchanged.
    pub verify_upstream_tls: Option<bool>,
    /// H3: hostnames always TLS-verified even when verify_upstream_tls is
    /// false. None ⇒ leave unchanged. This is the array form (matches the
    /// `Workspace.tlsVerifyHosts` frontend contract); the command serializes
    /// it to the JSON-encoded TEXT column.
    pub tls_verify_hosts: Option<Vec<String>>,
}

#[tauri::command]
pub async fn update_workspace(
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
        input.verify_upstream_tls,
        input.tls_verify_hosts.clone(),
    )?;

    // Persist to DB on the blocking pool. The DB column stores tls_verify_hosts
    // as a JSON-encoded string; serialize the array form here. Only the DB
    // write (and the connection lock) runs inside the closure; the in-memory
    // `update` above and the rollback below stay on the async task.
    let tls_verify_hosts_json = input
        .tls_verify_hosts
        .as_ref()
        .map(|hosts| serde_json::to_string(hosts).unwrap_or_else(|_| "[]".to_string()));

    let app_state = Arc::clone(state.inner());
    let updated_at = workspace.updated_at.clone();
    let db_result = run_blocking_command("update_workspace", move || {
        let conn = app_state.read_db_connection();
        let conn_guard = conn
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn_guard,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            input.http2_enabled,
            input.verify_upstream_tls,
            tls_verify_hosts_json.as_deref(),
            &updated_at,
        ) {
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
        Ok(())
    })
    .await;

    match db_result {
        Ok(()) => {
            tracing::info!(
                component = "desktop.commands",
                event = "update_workspace_succeeded",
                workspace_id = %workspace.id,
                "update_workspace_succeeded"
            );
            Ok(workspace)
        }
        Err(error) => {
            // Restore the prior in-memory state so memory matches the DB.
            if let Some(previous) = before.as_ref() {
                let _ = manager.update(
                    &previous.id,
                    Some(previous.name.clone()),
                    Some(previous.proxy_port),
                    Some(previous.ssl_enabled),
                    Some(previous.http2_enabled),
                    Some(previous.verify_upstream_tls),
                    Some(previous.tls_verify_hosts.clone()),
                );
            }
            Err(error)
        }
    }
}
