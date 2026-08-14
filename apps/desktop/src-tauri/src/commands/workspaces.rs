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
        let conn_guard = app_state.lock_db_for_ipc()?;
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
            // Empty string = never configured, which is what a fresh workspace
            // is. Serialization cannot realistically fail for this shape, but
            // degrade to "not configured" rather than aborting the create.
            upstream_proxy: workspace_for_db
                .upstream_proxy
                .as_ref()
                .and_then(|settings| serde_json::to_string(settings).ok())
                .unwrap_or_default(),
            ssl_proxying: workspace_for_db
                .ssl_proxying
                .as_ref()
                .and_then(|settings| serde_json::to_string(settings).ok())
                .unwrap_or_default(),
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
    /// Upstream (chained) proxy settings. None ⇒ leave unchanged. Sending a
    /// value with `enabled: false` keeps the settings but routes directly, so
    /// the user can toggle the chain off without retyping the configuration.
    /// Takes effect on the next proxy start/restart.
    pub upstream_proxy: Option<aiproxy_proxy_core::UpstreamProxySettings>,
    /// Per-host SSL proxying policy. None ⇒ leave unchanged. Takes effect on
    /// the next proxy start/restart.
    pub ssl_proxying: Option<aiproxy_proxy_core::SslProxyingSettings>,
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
        input.upstream_proxy.clone(),
        input.ssl_proxying.clone(),
    )?;

    // Persist to DB on the blocking pool. The DB column stores tls_verify_hosts
    // as a JSON-encoded string; serialize the array form here. Only the DB
    // write (and the connection lock) runs inside the closure; the in-memory
    // `update` above and the rollback below stay on the async task.
    let tls_verify_hosts_json = input
        .tls_verify_hosts
        .as_ref()
        .map(|hosts| serde_json::to_string(hosts).unwrap_or_else(|_| "[]".to_string()));
    // `None` here means "field not present in this update", which the DB layer
    // reads as "keep the stored value" — distinct from an explicitly disabled
    // configuration, which serializes to a JSON object with `enabled: false`.
    let upstream_proxy_json = input
        .upstream_proxy
        .as_ref()
        .map(|settings| serde_json::to_string(settings).unwrap_or_default());
    let ssl_proxying_json = input
        .ssl_proxying
        .as_ref()
        .map(|settings| serde_json::to_string(settings).unwrap_or_default());

    let app_state = Arc::clone(state.inner());
    let updated_at = workspace.updated_at.clone();
    let db_result = run_blocking_command("update_workspace", move || {
        let conn_guard = app_state.lock_db_for_ipc()?;
        if let Err(error) = aiproxy_db::workspaces::update_workspace(
            &conn_guard,
            &input.workspace_id,
            input.name.as_deref(),
            input.proxy_port,
            input.ssl_enabled,
            input.http2_enabled,
            input.verify_upstream_tls,
            tls_verify_hosts_json.as_deref(),
            upstream_proxy_json.as_deref(),
            ssl_proxying_json.as_deref(),
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
                    previous.upstream_proxy.clone(),
                    previous.ssl_proxying.clone(),
                );
            }
            Err(error)
        }
    }
}
