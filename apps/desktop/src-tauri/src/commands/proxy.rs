use super::certificates::try_load_tls_manager;
use super::common::*;
use crate::system_proxy_recovery;

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

#[tauri::command]
pub fn get_local_ip() -> Vec<String> {
    get_local_ip_addresses()
}

async fn start_proxy_impl(
    input: StartProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    let should_reapply_system_proxy = state.read_status().system_proxy_enabled;
    let port = input.port.unwrap_or(DEFAULT_PROXY_PORT);
    let enable_ssl = input.enable_ssl.unwrap_or(true);

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

    if shutdown_proxy_runtime(Arc::clone(&state)).await {
        log_debug(
            "desktop.commands",
            "previous_proxy_runtime_found",
            &[("workspace_id", input.workspace_id.clone())],
        );
    }

    // Resolve TLS manager for SSL interception
    let tls_manager = if enable_ssl {
        let existing = state.read_tls_manager();
        match existing {
            Some(m) => Some(m),
            None => {
                // Try loading existing root CA from disk
                match try_load_tls_manager() {
                    Ok(m) => {
                        state.set_tls_manager(Arc::clone(&m));
                        Some(m)
                    }
                    Err(_) => {
                        return Err(
                            "SSL interception requires a root certificate. Generate one on the Certificates page.".to_string()
                        );
                    }
                }
            }
        }
    } else {
        None
    };

    let breakpoint_manager = state.read_breakpoint_manager();
    let rewrite_manager = state.read_rewrite_manager();
    let map_manager = state.read_map_manager();
    let script_manager = state.read_script_manager();
    let throttle_manager = state.read_throttle_manager();

    let event_emitter: Option<BreakpointEventEmitter> = state.read_app_handle().map(|handle| {
        Arc::new(move |event: &str, payload: serde_json::Value| {
            let _ = handle.emit(event, payload);
        }) as BreakpointEventEmitter
    });

    let dns_manager = state.read_dns_manager();

    let started_proxy_server = start_proxy_server(
        ProxyRuntimeConfig {
            port,
            ssl_enabled: enable_ssl,
        },
        tls_manager,
        Some(breakpoint_manager),
        Some(rewrite_manager),
        Some(map_manager),
        Some(script_manager),
        Some(throttle_manager),
        Some(dns_manager),
        Some(input.workspace_id.clone()),
        event_emitter,
    )
    .await?;

    let mut session_receiver = started_proxy_server.session_receiver;
    let mut ws_message_receiver = started_proxy_server.ws_message_receiver;
    let state_for_collector = Arc::clone(&state);
    let state_for_ws = Arc::clone(&state);
    let collector_handle = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                session = session_receiver.recv() => {
                    match session {
                        Some(session) => state_for_collector.upsert_session(session),
                        None => break,
                    }
                }
                ws_msg = ws_message_receiver.recv() => {
                    match ws_msg {
                        Some(msg) => {
                            let conn = state_for_ws.read_db_connection().lock().expect("db mutex");
                            let row = aiproxy_db::sessions::WsMessageRow {
                                id: msg.id.clone(),
                                session_id: msg.session_id.clone(),
                                direction: msg.direction.clone(),
                                timestamp: msg.timestamp.clone(),
                                opcode: msg.opcode.clone(),
                                payload_text: msg.payload_text.clone(),
                                payload_size: msg.payload_size,
                                fin: msg.fin,
                            };
                            if let Err(e) = aiproxy_db::sessions::insert_ws_message(&conn, &row) {
                                crate::dev_logger::log_error(
                                    "desktop.ws_collector",
                                    "insert_ws_message_failed",
                                    &[("error", e)],
                                );
                            }
                            drop(conn);

                            // Emit to frontend
                            if let Some(handle) = state_for_ws.read_app_handle() {
                                let _ = handle.emit("ws-message", serde_json::json!({
                                    "id": msg.id,
                                    "sessionId": msg.session_id,
                                    "direction": msg.direction,
                                    "timestamp": msg.timestamp,
                                    "opcode": msg.opcode,
                                    "payloadText": msg.payload_text,
                                    "payloadSize": msg.payload_size,
                                    "fin": msg.fin,
                                }));
                            }
                        }
                        None => break,
                    }
                }
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
            (
                "workspace_id",
                status.active_workspace_id.clone().unwrap_or_default(),
            ),
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

    let _ = shutdown_proxy_runtime(Arc::clone(&state)).await;

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

pub(crate) async fn shutdown_proxy_runtime(state: Arc<AppState>) -> bool {
    let Some(runtime_handles) = state.take_runtime() else {
        return false;
    };

    state.read_breakpoint_manager().cancel_all();
    runtime_handles.collector_handle.abort();
    let _ = runtime_handles.collector_handle.await;
    runtime_handles.proxy_server_handle.shutdown().await;

    true
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

    if state.has_system_proxy_snapshot() {
        apply_system_proxy_settings(&settings)?;
    } else {
        let snapshot = capture_system_proxy_snapshot()?;
        if let Some(app_handle) = state.read_app_handle() {
            system_proxy_recovery::persist_pending_snapshot(
                &app_handle,
                status.active_workspace_id.clone(),
                &snapshot,
            )?;
        }
        apply_system_proxy_settings_with_pre_snapshot(&settings, snapshot.clone())?;
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

    state.set_system_proxy_recovery_warning(None);
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

    if let Some(app_handle) = state.read_app_handle() {
        if let Err(error) = system_proxy_recovery::clear_pending_snapshot(&app_handle) {
            log_warn(
                "desktop.commands",
                "disable_system_proxy_recovery_clear_failed",
                &[("error", error)],
            );
        }
    }

    log_info(
        "desktop.commands",
        "disable_system_proxy_succeeded",
        &[("reason", "user_request".to_string())],
    );

    Ok(state.set_system_proxy_enabled(false))
}

// --- Certificate command implementations ---
