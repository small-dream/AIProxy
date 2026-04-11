use crate::bootstrap::{AppState, BootstrapStatus};
use pharles_proxy_core::ProxyRuntimeConfig;
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
pub fn start_proxy(
    input: StartProxyInput,
    state: State<'_, AppState>,
) -> Result<BootstrapStatus, String> {
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

    Ok(state.start_proxy(port, enable_ssl, input.workspace_id))
}

#[tauri::command]
pub fn stop_proxy(input: StopProxyInput, state: State<'_, AppState>) -> BootstrapStatus {
    eprintln!(
        "level=INFO command=stop_proxy workspace_id={} reason=user_request",
        input.workspace_id
    );

    state.stop_proxy(input.workspace_id)
}
