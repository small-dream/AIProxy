use super::certificates::try_load_tls_manager;
use super::common::*;
use crate::system_proxy_recovery;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartProxyInput {
    pub workspace_id: String,
    pub port: Option<u16>,
    pub enable_ssl: Option<bool>,
    pub enable_http2: Option<bool>,
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

/// Restart the proxy server using the currently-applied status (same port,
/// ssl/http2 settings, same workspace). Used when an underlying component the
/// running proxy captured at start time must be refreshed — notably the TLS
/// manager after a root-CA rotation (Finding #1): the running proxy's
/// `ServerConfig` embeds a `DynamicCertResolver` that holds the OLD
/// `root_ca_sign_data`, so a bare AppState swap + `clear_host_cache` would let
/// it re-sign host certs with the old root. Restarting rebuilds the server
/// config from the freshly-installed `TlsManager`.
///
/// No-op (returns Ok) when the proxy is not running. Errors propagate so the
/// caller can surface a notification; on error the proxy is left stopped.
pub(crate) async fn restart_proxy_if_running(state: Arc<AppState>) -> Result<(), String> {
    restart_proxy_with_ssl_override(state, None).await
}

/// Same restart contract as [`restart_proxy_if_running`], but `ssl_override`
/// replaces the workspace's persisted `ssl_enabled` for the restart. The
/// certificate-removal flow passes `Some(false)`: the root CA files are gone,
/// so restarting with SSL on would immediately fail with ERR_CERT_NOT_FOUND
/// (see the TLS-manager resolution in `start_proxy_impl`).
pub(crate) async fn restart_proxy_with_ssl_override(
    state: Arc<AppState>,
    ssl_override: Option<bool>,
) -> Result<(), String> {
    let status = state.read_status();
    if !status.running {
        return Ok(());
    }
    let workspace_id = status
        .active_workspace_id
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let input = StartProxyInput {
        workspace_id,
        port: Some(status.port),
        enable_ssl: ssl_override.or(Some(status.ssl_enabled)),
        enable_http2: Some(status.http2_enabled),
    };
    // start_proxy_impl shuts down any prior runtime before starting the new
    // one, so this is a clean rebuild with the current TlsManager.
    start_proxy_impl(input, state).await.map(|_| ())
}

async fn start_proxy_impl(
    input: StartProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    // NOTE: do NOT snapshot `system_proxy_enabled` here. start/restart does
    // substantial async work (shutdown prior runtime, bind, start collectors)
    // before the system-proxy reapply decision; a concurrent enable/disable can
    // change the flag during that window. The reapply decision is made at the
    // very end, while holding `system_proxy_op_lock`, by re-reading the
    // authoritative current state (see the reapply block near the end).
    let port = input.port.unwrap_or(DEFAULT_PROXY_PORT);
    let enable_ssl = input.enable_ssl.unwrap_or(true);

    let http2_enabled = input.enable_http2;

    ProxyRuntimeConfig {
        port,
        ssl_enabled: enable_ssl,
        http2_enabled,
        // Pre-validation only checks the port; the real verify flag is
        // resolved from the workspace below and passed to start_proxy_server.
        verify_upstream_tls: false,
        tls_verify_hosts: std::sync::Arc::from(Vec::<String>::new()),
        ssl_blind_hosts: std::sync::Arc::from(Vec::<String>::new()),
    }
    .validate()
    .map_err(|message| message.to_string())?;

    tracing::info!(
        component = "desktop.commands",
        event = "start_proxy_requested",
        workspace_id = %input.workspace_id,
        port = %port,
        ssl_enabled = %enable_ssl,
        "start_proxy_requested"
    );

    if shutdown_proxy_runtime(Arc::clone(&state)).await {
        tracing::debug!(
            component = "desktop.commands",
            event = "previous_proxy_runtime_found",
            workspace_id = %input.workspace_id,
            "previous_proxy_runtime_found"
        );
    }

    // Resolve TLS manager for SSL interception
    let tls_manager = if enable_ssl {
        let existing = state.read_tls_manager();
        let h2 = http2_enabled.unwrap_or(true);
        // Invalidate cached TLS manager if http2_enabled changed (ALPN config is baked in)
        let compatible = existing.as_ref().is_some_and(|m| m.http2_enabled == h2);
        if compatible {
            existing
        } else {
            // Rebuild TLS manager with current http2_enabled (ALPN config is baked in).
            // set_tls_manager atomically replaces the old one on success;
            // if loading fails, the old manager is preserved.
            match try_load_tls_manager(http2_enabled) {
                Ok(m) => {
                    state.set_tls_manager(Arc::clone(&m));
                    Some(m)
                }
                Err(_) => {
                    return Err(app_error(
                        ERR_CERT_NOT_FOUND,
                        "SSL interception requires a root certificate. Generate one on the Certificates page.",
                    ));
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

    // Load the workspace once and derive both the upstream-TLS-verification
    // config and the per-host SSL-decryption opt-out list from it. Falls back
    // to off/empty (historical defaults) if the workspace can't be loaded.
    let loaded_workspace = state.read_workspace_manager().load(&input.workspace_id);
    let (verify_upstream_tls, tls_verify_hosts) = loaded_workspace
        .as_ref()
        .map(|ws| (ws.verify_upstream_tls, ws.tls_verify_hosts.clone()))
        .unwrap_or_else(|| (false, Vec::new()));
    // Per-host SSL-decryption opt-out list. Trim + de-duplicate defensively
    // (the workspace UI maintains a set); the CONNECT handler compares
    // case-insensitively via host_in_allowlist, so no lowercasing is needed.
    let ssl_blind_hosts: Vec<String> = loaded_workspace
        .map(|ws| {
            let mut seen = std::collections::HashSet::new();
            ws.ssl_blind_hosts
                .into_iter()
                .map(|host| host.trim().to_string())
                .filter(|host| !host.is_empty() && seen.insert(host.clone()))
                .collect()
        })
        .unwrap_or_default();
    if verify_upstream_tls || !tls_verify_hosts.is_empty() {
        tracing::info!(
            component = "desktop.commands",
            event = "upstream_tls_verification_configured",
            workspace_id = %input.workspace_id,
            verify_upstream_tls,
            allowlist_len = tls_verify_hosts.len(),
            "upstream_tls_verification_configured"
        );
    }

    let started_proxy_server = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port,
                ssl_enabled: enable_ssl,
                http2_enabled,
                verify_upstream_tls,
                tls_verify_hosts: std::sync::Arc::from(tls_verify_hosts),
                ssl_blind_hosts: std::sync::Arc::from(ssl_blind_hosts),
            },
            workspace_id: Some(input.workspace_id.clone()),
            event_emitter,
        },
        ProxyManagers {
            tls: tls_manager,
            breakpoint: Some(breakpoint_manager),
            rewrite: Some(rewrite_manager),
            map: Some(map_manager),
            script: Some(script_manager),
            throttle: Some(throttle_manager),
            dns: Some(dns_manager),
        },
    )
    .await?;

    let mut session_receiver = started_proxy_server.session_receiver;
    let mut ws_message_receiver = started_proxy_server.ws_message_receiver;
    let state_for_collector = Arc::clone(&state);
    let state_for_ws = Arc::clone(&state);
    let collector_handle = tauri::async_runtime::spawn(async move {
        // H8: track in-flight WS insert tasks so persistence is decoupled from
        // the receive loop. Previously each insert was awaited inline, so the
        // loop could not recv() the next message until the DB insert (contending
        // for the global Connection mutex) completed. We cap the in-flight count
        // to apply backpressure (draining the oldest when full), mirroring how
        // the session branch backpressures via upsert_session_batch_async.
        const MAX_INFLIGHT_WS_INSERTS: usize = 64;
        let mut inflight_ws_inserts: Vec<tauri::async_runtime::JoinHandle<()>> = Vec::new();

        loop {
            tokio::select! {
                session = session_receiver.recv() => {
                    match session {
                        Some(first) => {
                            let mut batch = vec![first];
                            while batch.len() < SESSION_BATCH_SIZE {
                                match session_receiver.try_recv() {
                                    Ok(s) => batch.push(s),
                                    Err(_) => break,
                                }
                            }
                            state_for_collector.upsert_session_batch_async(batch).await;
                        }
                        None => break,
                    }
                }
                ws_msg = ws_message_receiver.recv() => {
                    match ws_msg {
                        Some(msg) => {
                            // Offload WS message DB insert to blocking thread.
                            let db = Arc::clone(state_for_ws.read_db_connection());
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
                            // H8: do NOT await — spawn and track the handle so the
                            // receive loop can pull the next message immediately.
                            let handle = tauri::async_runtime::spawn_blocking(move || {
                                // Fail-closed on poison: skip the insert rather
                                // than write through a poisoned Connection.
                                let conn = match crate::bootstrap::lock_recovery::lock_db_best_effort(
                                    &db,
                                    "ws_collector",
                                ) {
                                    Ok(conn) => conn,
                                    Err(()) => return,
                                };
                                if let Err(e) = aiproxy_db::sessions::insert_ws_message(&conn, &row) {
                                    tracing::error!(
                                        component = "desktop.ws_collector",
                                        event = "insert_ws_message_failed",
                                        error = %e,
                                        "insert_ws_message_failed"
                                    );
                                }
                            });
                            inflight_ws_inserts.push(handle);
                            // H8: backpressure — if too many inserts are in flight,
                            // await the oldest to bound memory/task growth.
                            while inflight_ws_inserts.len() > MAX_INFLIGHT_WS_INSERTS {
                                if let Some(oldest) = inflight_ws_inserts.first_mut() {
                                    let _ = oldest.await;
                                }
                                inflight_ws_inserts.remove(0);
                            }

                            // Emit to frontend immediately (decoupled from DB persist).
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

        // H8: drain remaining in-flight inserts before the collector task exits.
        for handle in inflight_ws_inserts {
            let _ = handle.await;
        }
    });

    state.set_runtime(RuntimeHandles {
        collector_handle,
        proxy_server_handle: started_proxy_server.server_handle,
    });

    let status = state.start_proxy(
        started_proxy_server.bound_port,
        enable_ssl,
        http2_enabled.unwrap_or(true),
        input.workspace_id,
    );

    // System-proxy reapply. Always run this epilogue (not gated by a flag
    // snapshot taken at the top): a concurrent enable/disable can flip
    // `system_proxy_enabled` during the async start work above, in either
    // direction. Holding the op lock and re-reading the authoritative current
    // state covers every transition:
    //   - true→true: re-apply to the new `status.port` (e.g. restart on a port
    //     change, or root-CA rotation rebuild).
    //   - false→true: a concurrent enable applied the OLD (now-stale) port;
    //     re-apply to `status.port` so the OS proxy points at the live proxy.
    //   - true→false: a concurrent disable restored+cleared the snapshot; skip
    //     re-apply (do not re-enable the OS proxy the user just disabled).
    let _reapply_guard = state.system_proxy_op_lock().lock().await;
    let system_proxy_enabled = state.read_status().system_proxy_enabled;
    if system_proxy_enabled {
        // H11: apply spawns blocking platform I/O (networksetup/gsettings/
        // registry); offload so the tokio worker is not parked.
        let reapply_settings = SystemProxySettings::localhost(status.port);
        // H4: reapply failure must NOT abort an otherwise-successful start. By
        // this point the listener is bound, RuntimeHandles are registered, and
        // status is Running. Returning Err here would leave an orphaned proxy
        // the renderer cannot stop. Treat a reapply failure as a non-fatal
        // warning: log it and emit a frontend event so the UI can show a
        // banner, but return Ok(status).
        let state_for_warn = Arc::clone(&state);
        if let Err(error) = run_blocking_command("start_proxy_reapply_system_proxy", move || {
            apply_system_proxy_settings(&reapply_settings)
        })
        .await
        {
            tracing::warn!(
                component = "desktop.commands",
                event = "start_proxy_system_proxy_reapply_failed",
                error = %error,
                "system proxy reapply failed after successful proxy start; proxy is running but OS proxy may be stale"
            );
            if let Some(handle) = state_for_warn.read_app_handle() {
                let _ = handle.emit(
                    "system-proxy-warning",
                    serde_json::json!({"reason": "reapply_failed", "error": &error}),
                );
            }
        }
    } else {
        tracing::debug!(
            component = "desktop.commands",
            event = "start_proxy_system_proxy_reapply_skipped_disabled",
            "system proxy disabled; skipping reapply"
        );
    }

    tracing::info!(
        component = "desktop.commands",
        event = "start_proxy_succeeded",
        workspace_id = %status.active_workspace_id.clone().unwrap_or_default(),
        bound_port = %status.port,
        ssl_enabled = %status.ssl_enabled,
        "start_proxy_succeeded"
    );

    Ok(status)
}

async fn stop_proxy_impl(
    input: StopProxyInput,
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    tracing::info!(
        component = "desktop.commands",
        event = "stop_proxy_requested",
        workspace_id = %input.workspace_id,
        reason = "user_request",
        "stop_proxy_requested"
    );

    if state.read_status().system_proxy_enabled {
        if let Err(error) = disable_system_proxy_impl(Arc::clone(&state)).await {
            tracing::warn!(
                component = "desktop.commands",
                event = "stop_proxy_system_proxy_restore_failed",
                workspace_id = %input.workspace_id,
                error = %error,
                "stop_proxy_system_proxy_restore_failed"
            );
        }
    }

    let _ = shutdown_proxy_runtime(Arc::clone(&state)).await;

    let status = state.stop_proxy(input.workspace_id);

    tracing::info!(
        component = "desktop.commands",
        event = "stop_proxy_succeeded",
        workspace_id = %status.active_workspace_id.clone().unwrap_or_default(),
        running = %status.running,
        "stop_proxy_succeeded"
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
    // M17: serialize against concurrent disable/restart so overlapping IPC
    // calls cannot interleave snapshot capture/restore and desynchronize the
    // snapshot from the actually-applied state.
    let _op_guard = state.system_proxy_op_lock().lock().await;

    let status = state.read_status();

    if !status.running {
        tracing::warn!(
            component = "desktop.commands",
            event = "enable_system_proxy_rejected",
            reason = "proxy_must_be_running_before_enabling_system_proxy",
            "enable_system_proxy_rejected"
        );
        return Err(app_error(
            ERR_PROXY_NOT_RUNNING,
            "Proxy must be running before enabling the system proxy.",
        ));
    }

    let settings = SystemProxySettings::localhost(status.port);
    let workspace_id = status.active_workspace_id.clone();
    let app_handle = state.read_app_handle();
    let already_has_snapshot = state.has_system_proxy_snapshot();

    if already_has_snapshot {
        // H11: capture/apply spawn `networksetup`/`gsettings`/registry I/O and
        // must not block the tokio worker thread.
        let settings_for_blocking = settings.clone();
        run_blocking_command("enable_system_proxy_reapply", move || {
            apply_system_proxy_settings(&settings_for_blocking)
        })
        .await?;
    } else {
        // H11: snapshot capture + persist + apply are all blocking; run them in
        // one spawn_blocking task so the ordering (persist-before-apply, see
        // system_proxy_recovery) is preserved without parking a worker thread.
        let settings_for_blocking = settings.clone();
        let app_handle_for_blocking = app_handle.clone();
        let workspace_id_for_blocking = workspace_id.clone();
        let snapshot = run_blocking_command(
            "enable_system_proxy_capture_apply",
            move || -> Result<crate::system_proxy::SystemProxySnapshot, String> {
                let snapshot = capture_system_proxy_snapshot()?;
                if let Some(handle) = &app_handle_for_blocking {
                    system_proxy_recovery::persist_pending_snapshot(
                        handle,
                        workspace_id_for_blocking.clone(),
                        &snapshot,
                    )?;
                }
                apply_system_proxy_settings_with_pre_snapshot(
                    &settings_for_blocking,
                    snapshot.clone(),
                )?;
                Ok(snapshot)
            },
        )
        .await?;
        state.store_system_proxy_snapshot(snapshot);
    }

    tracing::info!(
        component = "desktop.commands",
        event = "enable_system_proxy_succeeded",
        port = %status.port,
        endpoint = %settings.endpoint(),
        "enable_system_proxy_succeeded"
    );

    state.set_system_proxy_recovery_warning(None);

    // M9: persist the toggle to the workspace row so it survives restart. The
    // OS proxy has already been applied at this point. If the DB write fails we
    // cannot silently proceed — the in-memory status would say enabled while
    // the workspace row stays stale, recreating the exact cross-restart drift
    // M9 was meant to fix. Rather than roll back the already-applied OS proxy
    // (which is more disruptive than the drift itself), we surface a DEGRADED
    // state: the toggle is enabled in memory AND a recovery warning is set so
    // the UI can prompt the user to retry. The next successful persist or
    // restart re-syncs.
    let persist_failed = if let Some(workspace_id) = &workspace_id {
        let workspace_id = workspace_id.clone();
        let state_for_persist = Arc::clone(&state);
        let result = run_blocking_command("enable_system_proxy_persist", move || {
            let conn = state_for_persist.lock_db_for_ipc()?;
            aiproxy_db::workspaces::set_workspace_system_proxy_enabled(&conn, &workspace_id, true)
                .map_err(|e| app_error(ERR_INTERNAL, format!("persist system_proxy_enabled: {e}")))
        })
        .await;
        if let Err(error) = &result {
            tracing::warn!(
                component = "desktop.commands",
                event = "enable_system_proxy_persist_failed",
                error = %error,
                "enable_system_proxy_persist_failed: OS proxy applied but the workspace toggle was NOT persisted; UI is degraded"
            );
        }
        result.is_err()
    } else {
        false
    };

    let mut status = state.set_system_proxy_enabled(true);
    if persist_failed {
        status = state.set_system_proxy_recovery_warning(Some(
            "The system proxy was enabled, but the preference could not be saved. It may revert after restarting the app. Retry saving from Settings.".to_string(),
        ));
    }
    Ok(status)
}

pub(crate) async fn disable_system_proxy_impl(
    state: Arc<AppState>,
) -> Result<BootstrapStatus, String> {
    // M17: serialize against concurrent enable/restart (see enable_system_proxy_impl).
    let _op_guard = state.system_proxy_op_lock().lock().await;

    // M9: capture the workspace id before the restore so we can persist the
    // toggle after the system-proxy restore succeeds.
    let workspace_id = state.read_status().active_workspace_id.clone();

    if let Some(snapshot) = state.take_system_proxy_snapshot() {
        // H11: restore spawns blocking subprocesses (networksetup/gsettings)
        // or synchronous registry I/O; offload so the tokio worker is not parked.
        // Keep a clone so we can put the original snapshot back on restore
        // failure (the moved copy travels into the spawn_blocking task).
        let snapshot_for_restore = snapshot.clone();
        let restore_result = run_blocking_command("disable_system_proxy_restore", move || {
            restore_system_proxy(&snapshot_for_restore)
        })
        .await;

        if let Err(error) = restore_result {
            // Put the original snapshot back so a later disable/restart can retry.
            state.store_system_proxy_snapshot(snapshot);

            tracing::error!(
                component = "desktop.commands",
                event = "disable_system_proxy_restore_failed",
                error = %error,
                "disable_system_proxy_restore_failed"
            );

            return Err(error);
        }
    }

    if let Some(app_handle) = state.read_app_handle() {
        if let Err(error) = run_blocking_command("disable_system_proxy_clear_recovery", move || {
            system_proxy_recovery::clear_pending_snapshot(&app_handle)
        })
        .await
        {
            tracing::warn!(
                component = "desktop.commands",
                event = "disable_system_proxy_recovery_clear_failed",
                error = %error,
                "disable_system_proxy_recovery_clear_failed"
            );
        }
    }

    tracing::info!(
        component = "desktop.commands",
        event = "disable_system_proxy_succeeded",
        reason = "user_request",
        "disable_system_proxy_succeeded"
    );

    // M9: persist the disabled toggle to the workspace row so it survives
    // restart. The OS proxy has already been restored at this point. If the DB
    // write fails we surface a DEGRADED state (recovery warning) rather than
    // silently leaving the workspace row stale — see enable_system_proxy_impl
    // for the full rationale.
    let persist_failed = if let Some(workspace_id) = &workspace_id {
        let workspace_id = workspace_id.clone();
        let state_for_persist = Arc::clone(&state);
        let result = run_blocking_command("disable_system_proxy_persist", move || {
            let conn = state_for_persist.lock_db_for_ipc()?;
            aiproxy_db::workspaces::set_workspace_system_proxy_enabled(&conn, &workspace_id, false)
                .map_err(|e| app_error(ERR_INTERNAL, format!("persist system_proxy_enabled: {e}")))
        })
        .await;
        if let Err(error) = &result {
            tracing::warn!(
                component = "desktop.commands",
                event = "disable_system_proxy_persist_failed",
                error = %error,
                "disable_system_proxy_persist_failed: OS proxy restored but the workspace toggle was NOT persisted; UI is degraded"
            );
        }
        result.is_err()
    } else {
        false
    };

    let mut status = state.set_system_proxy_enabled(false);
    if persist_failed {
        status = state.set_system_proxy_recovery_warning(Some(
            "The system proxy was disabled, but the preference could not be saved. It may revert after restarting the app. Retry saving from Settings.".to_string(),
        ));
    }
    Ok(status)
}

// --- Certificate command implementations ---
