use crate::bootstrap::{AppState, BootstrapStatus, RuntimeHandles};
use crate::system_proxy::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    SystemProxySettings,
};
use pharles_proxy_core::{start_proxy_server, ProxyRuntimeConfig, ProxySessionSummary};
use serde::Deserialize;
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
pub fn get_bootstrap_status(state: State<'_, AppState>) -> BootstrapStatus {
    state.read_status()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<ProxySessionSummary> {
    state.read_sessions()
}

#[tauri::command]
pub fn start_proxy(
    input: StartProxyInput,
    state: State<'_, AppState>,
) -> Result<BootstrapStatus, String> {
    tauri::async_runtime::block_on(start_proxy_impl(input, state))
}

#[tauri::command]
pub fn stop_proxy(input: StopProxyInput, state: State<'_, AppState>) -> BootstrapStatus {
    tauri::async_runtime::block_on(stop_proxy_impl(input, state))
}

#[tauri::command]
pub fn enable_system_proxy(state: State<'_, AppState>) -> Result<BootstrapStatus, String> {
    tauri::async_runtime::block_on(enable_system_proxy_impl(&state))
}

#[tauri::command]
pub fn disable_system_proxy(state: State<'_, AppState>) -> Result<BootstrapStatus, String> {
    tauri::async_runtime::block_on(disable_system_proxy_impl(&state))
}

async fn start_proxy_impl(
    input: StartProxyInput,
    state: State<'_, AppState>,
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

    eprintln!(
        "level=INFO command=start_proxy workspace_id={} port={} ssl_enabled={}",
        input.workspace_id, port, enable_ssl
    );

    if let Some(runtime_handles) = state.take_runtime() {
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

    Ok(status)
}

async fn stop_proxy_impl(input: StopProxyInput, state: State<'_, AppState>) -> BootstrapStatus {
    eprintln!(
        "level=INFO command=stop_proxy workspace_id={} reason=user_request",
        input.workspace_id
    );

    if let Some(runtime_handles) = state.take_runtime() {
        runtime_handles.proxy_server_handle.shutdown().await;
        let _ = runtime_handles.collector_handle.await;
    }

    if state.read_status().system_proxy_enabled {
        if let Err(error) = disable_system_proxy_impl(&state).await {
            eprintln!(
                "level=WARN command=stop_proxy event=system_proxy_restore_failed workspace_id={} error=\"{}\"",
                input.workspace_id, error
            );
        }
    }

    state.stop_proxy(input.workspace_id)
}

async fn enable_system_proxy_impl(state: &AppState) -> Result<BootstrapStatus, String> {
    let status = state.read_status();

    if !status.running {
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

    eprintln!(
        "level=INFO command=enable_system_proxy port={} endpoint={}",
        status.port,
        settings.endpoint()
    );

    Ok(state.set_system_proxy_enabled(true))
}

async fn disable_system_proxy_impl(state: &AppState) -> Result<BootstrapStatus, String> {
    if let Some(snapshot) = state.take_system_proxy_snapshot() {
        if let Err(error) = restore_system_proxy(&snapshot) {
            state.store_system_proxy_snapshot(snapshot);

            return Err(error);
        }
    }

    eprintln!("level=INFO command=disable_system_proxy reason=user_request");

    Ok(state.set_system_proxy_enabled(false))
}
