use crate::bootstrap::{AppState, BootstrapStatus, RuntimeHandles};
use crate::dev_logger::{log_debug, log_error, log_info, log_warn};
use crate::system_proxy::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    SystemProxySettings,
};
use pharles_proxy_core::{start_proxy_server, ProxyRuntimeConfig, ProxySessionSummary};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

const DEFAULT_PROXY_PORT: u16 = 8888;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartProxyInput {
    pub workspace_id: String,
    pub port: Option<u16>,
    pub enable_ssl: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopProxyInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn get_bootstrap_status(state: State<'_, Arc<AppState>>) -> BootstrapStatus {
    state.read_status()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<AppState>>) -> Vec<ProxySessionSummary> {
    state.read_sessions()
}

#[tauri::command]
pub async fn start_proxy(
    input: StartProxyInput,
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    start_proxy_impl(input, Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn stop_proxy(
    input: StopProxyInput,
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    stop_proxy_impl(input, Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn enable_system_proxy(
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    enable_system_proxy_impl(Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn disable_system_proxy(
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    disable_system_proxy_impl(Arc::clone(state.inner())).await
}

async fn start_proxy_impl(
    input: StartProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    let should_reapply_system_proxy = state.read_status().system_proxy_enabled;
    let port = input.port.unwrap_or(DEFAULT_PROXY_PORT);
    let enable_ssl = input.enable_ssl.unwrap_or(false);

    ProxyRuntimeConfig {
        port,
        ssl_enabled: enable_ssl,
    }
    .validate()
    .map_err(|message| message.to_string())?;

    log_info(
        "desktop.commands",
        "start_proxy_requested",
        &[
            ("workspace_id", input.workspace_id.clone()),
            ("port", port.to_string()),
            ("ssl_enabled", enable_ssl.to_string()),
            (
                "system_proxy_enabled",
                should_reapply_system_proxy.to_string(),
            ),
        ],
    );

    if let Some(runtime_handles) = state.take_runtime() {
        log_debug(
            "desktop.commands",
            "previous_proxy_runtime_found",
            &[("workspace_id", input.workspace_id.clone())],
        );
        runtime_handles.proxy_server_handle.shutdown().await;
        let _ = runtime_handles.collector_handle.await;
    }

    state.clear_sessions();

    let started_proxy_server = start_proxy_server(ProxyRuntimeConfig {
        port,
        ssl_enabled: enable_ssl,
    })
    .await?;

    let session_store = state.session_store();
    let mut session_receiver = started_proxy_server.session_receiver;
    let collector_handle = tauri::async_runtime::spawn(async move {
        while let Some(session) = session_receiver.recv().await {
            let mut sessions = session_store
                .lock()
                .expect("session list mutex should not be poisoned");

            sessions.insert(0, session);

            if sessions.len() > 500 {
                sessions.truncate(500);
            }
        }
    });

    state.set_runtime(RuntimeHandles {
        collector_handle,
        proxy_server_handle: started_proxy_server.server_handle,
    });

    let status = state.start_proxy(
        started_proxy_server.bound_port,
        enable_ssl,
        input.workspace_id,
    );

    if should_reapply_system_proxy {
        apply_system_proxy_settings(&SystemProxySettings::localhost(status.port))?;
    }

    log_info(
        "desktop.commands",
        "start_proxy_succeeded",
        &[
            ("workspace_id", status.active_workspace_id.clone().unwrap_or_default()),
            ("bound_port", status.port.to_string()),
            ("ssl_enabled", status.ssl_enabled.to_string()),
        ],
    );

    Ok(status)
}

async fn stop_proxy_impl(
    input: StopProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    log_info(
        "desktop.commands",
        "stop_proxy_requested",
        &[
            ("workspace_id", input.workspace_id.clone()),
            ("reason", "user_request".to_string()),
        ],
    );

    if let Some(runtime_handles) = state.take_runtime() {
        runtime_handles.proxy_server_handle.shutdown().await;
        let _ = runtime_handles.collector_handle.await;
    }

    if state.read_status().system_proxy_enabled {
        if let Err(error) = disable_system_proxy_impl(Arc::clone(&state)).await {
            log_warn(
                "desktop.commands",
                "stop_proxy_system_proxy_restore_failed",
                &[
                    ("workspace_id", input.workspace_id.clone()),
                    ("error", error),
                ],
            );
        }
    }

    let status = state.stop_proxy(input.workspace_id);

    log_info(
        "desktop.commands",
        "stop_proxy_succeeded",
        &[
            (
                "workspace_id",
                status.active_workspace_id.clone().unwrap_or_default(),
            ),
            ("running", status.running.to_string()),
        ],
    );

    Ok(status)
}

async fn enable_system_proxy_impl(state: Arc<AppState>) -> Result<BootstrapStatus, String> {
    let status = state.read_status();

    if !status.running {
        log_warn(
            "desktop.commands",
            "enable_system_proxy_rejected",
            &[(
                "reason",
                "proxy_must_be_running_before_enabling_system_proxy".to_string(),
            )],
        );
        return Err("proxy must be running before enabling the system proxy".to_string());
    }

    let settings = SystemProxySettings::localhost(status.port);
    let captured_snapshot = if state.has_system_proxy_snapshot() {
        None
    } else {
        Some(capture_system_proxy_snapshot()?)
    };

    apply_system_proxy_settings(&settings)?;

    if let Some(snapshot) = captured_snapshot {
        state.store_system_proxy_snapshot(snapshot);
    }

    log_info(
        "desktop.commands",
        "enable_system_proxy_succeeded",
        &[
            ("port", status.port.to_string()),
            ("endpoint", settings.endpoint()),
        ],
    );

    Ok(state.set_system_proxy_enabled(true))
}

async fn disable_system_proxy_impl(state: Arc<AppState>) -> Result<BootstrapStatus, String> {
    if let Some(snapshot) = state.take_system_proxy_snapshot() {
        if let Err(error) = restore_system_proxy(&snapshot) {
            state.store_system_proxy_snapshot(snapshot);

            log_error(
                "desktop.commands",
                "disable_system_proxy_restore_failed",
                &[("error", error.clone())],
            );

            return Err(error);
        }
    }

    log_info(
        "desktop.commands",
        "disable_system_proxy_succeeded",
        &[("reason", "user_request".to_string())],
    );

    Ok(state.set_system_proxy_enabled(false))
}
