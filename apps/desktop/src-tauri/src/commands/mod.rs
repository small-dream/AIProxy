use crate::bootstrap::{AppState, BootstrapStatus, CertificateStateSnapshot, RuntimeHandles};
use crate::dev_logger::{log_debug, log_error, log_info, log_warn};
use crate::system_proxy::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    SystemProxySettings,
};
use pharles_proxy_core::{
    start_proxy_server, ProxyRuntimeConfig, ProxySessionDetail, ProxySessionSummary, TlsManager,
};
use pharles_tls_manager::{detect_platform, is_cert_trusted_on_platform, CertStorage, RootCaPair};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionDetailInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRootCertificateInput {
    pub force_regenerate: Option<bool>,
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
pub fn get_session_detail(
    input: GetSessionDetailInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ProxySessionDetail, String> {
    state
        .read_session_detail(&input.session_id)
        .ok_or_else(|| format!("captured session {} was not found", input.session_id))
}

#[tauri::command]
pub fn clear_sessions(state: State<'_, Arc<AppState>>) {
    state.clear_sessions();
}

#[tauri::command]
pub fn get_certificate_status(
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    get_certificate_status_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn generate_root_certificate(
    input: GenerateRootCertificateInput,
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    generate_root_certificate_impl(input, Arc::clone(state.inner()))
}

#[tauri::command]
pub fn open_certificate_install_guide(
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    open_certificate_install_guide_impl(Arc::clone(state.inner()))
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

    let started_proxy_server = start_proxy_server(
        ProxyRuntimeConfig {
            port,
            ssl_enabled: enable_ssl,
        },
        tls_manager,
    )
    .await?;

    let mut session_receiver = started_proxy_server.session_receiver;
    let state_for_collector = Arc::clone(&state);
    let collector_handle = tauri::async_runtime::spawn(async move {
        while let Some(session) = session_receiver.recv().await {
            state_for_collector.insert_session(session);
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

// --- Certificate command implementations ---

fn get_certificate_status_impl(state: Arc<AppState>) -> Result<CertificateStateSnapshot, String> {
    let platform = detect_platform();

    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        let status = CertificateStateSnapshot {
            cert_path: None,
            fingerprint: None,
            trusted: false,
            platform: platform.to_string(),
        };
        state.update_cert_status(status.clone());
        return Ok(status);
    }

    let cert_pem = storage.load_root_cert_pem()
        .map_err(|e| format!("failed to read root cert: {e}"))?;
    let key_pem = storage.load_root_key_pem()
        .map_err(|e| format!("failed to read root key: {e}"))?;

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| format!("failed to load root CA: {e}"))?;

    let trusted = is_cert_trusted_on_platform(storage.root_cert_path(), platform);

    let status = CertificateStateSnapshot {
        cert_path: Some(storage.root_cert_path().to_string_lossy().to_string()),
        fingerprint: Some(root_ca.fingerprint().to_string()),
        trusted,
        platform: platform.to_string(),
    };

    state.update_cert_status(status.clone());

    Ok(status)
}

fn generate_root_certificate_impl(
    input: GenerateRootCertificateInput,
    state: Arc<AppState>,
) -> Result<CertificateStateSnapshot, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    // If already exists and not forcing regeneration, return existing status
    if storage.root_cert_exists() && !input.force_regenerate.unwrap_or(false) {
        return get_certificate_status_impl(state);
    }

    // Generate new root CA
    let root_ca = RootCaPair::generate()
        .map_err(|e| format!("failed to generate root CA: {e}"))?;

    storage.save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
        .map_err(|e| format!("failed to save root CA: {e}"))?;

    // Create server config for MITM
    let server_config = root_ca.create_server_config(&storage)
        .map_err(|e| format!("failed to create TLS server config: {e}"))?;

    // Store TlsManager in AppState
    let tls_manager = Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
    });
    state.set_tls_manager(tls_manager);

    // Return updated status
    get_certificate_status_impl(state)
}

fn open_certificate_install_guide_impl(
    state: Arc<AppState>,
) -> Result<serde_json::Value, String> {
    let platform = detect_platform();
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status.cert_path.clone().unwrap_or_default();

    let steps = match platform {
        pharles_tls_manager::Platform::Windows => vec![
            serde_json::json!({"order": 1, "description": "Press Win+R, type certlm.msc, and press Enter to open the Local Machine Certificate Manager."}),
            serde_json::json!({"order": 2, "description": "Navigate to Trusted Root Certification Authorities > Certificates in the left panel."}),
            serde_json::json!({"order": 3, "description": "Right-click on Certificates folder, select All Tasks > Import."}),
            serde_json::json!({"order": 4, "description": "Click Next, then browse to the certificate file and select it."}),
            serde_json::json!({"order": 5, "description": format!("Certificate path: {}", cert_path)}),
            serde_json::json!({"order": 6, "description": "Ensure 'Place all certificates in the following store' shows 'Trusted Root Certification Authorities' and click Next."}),
            serde_json::json!({"order": 7, "description": "Click Finish. Accept the security warning about installing a root certificate."}),
            serde_json::json!({"order": 8, "description": "Restart your browser for the change to take effect."}),
        ],
        pharles_tls_manager::Platform::Macos => vec![
            serde_json::json!({"order": 1, "description": format!("Double-click the certificate file at: {}", cert_path)}),
            serde_json::json!({"order": 2, "description": "Open Keychain Access. The certificate will appear in the 'login' keychain."}),
            serde_json::json!({"order": 3, "description": "Drag the certificate to the 'System' keychain in the left sidebar."}),
            serde_json::json!({"order": 4, "description": "Double-click the certificate in System keychain, expand Trust, and set 'When using this certificate' to 'Always Trust'."}),
            serde_json::json!({"order": 5, "description": "Close the window. You will be prompted for your administrator password."}),
            serde_json::json!({"order": 6, "description": "Restart your browser for the change to take effect."}),
        ],
        pharles_tls_manager::Platform::Linux => vec![
            serde_json::json!({"order": 1, "description": format!("Copy the certificate to the system CA directory: sudo cp {} /usr/local/share/ca-certificates/pharles-root-ca.crt", cert_path)}),
            serde_json::json!({"order": 2, "description": "Update the CA store: sudo update-ca-certificates"}),
            serde_json::json!({"order": 3, "description": "Restart your browser for the change to take effect."}),
        ],
    };

    Ok(serde_json::json!({
        "success": true,
        "certPath": cert_path,
        "platform": platform.to_string(),
        "steps": steps,
    }))
}

/// Try to load a TlsManager from an existing root CA on disk.
fn try_load_tls_manager() -> Result<Arc<TlsManager>, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("cert storage resolve: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("no root certificate found".to_string());
    }

    let cert_pem = storage.load_root_cert_pem()
        .map_err(|e| format!("read cert: {e}"))?;
    let key_pem = storage.load_root_key_pem()
        .map_err(|e| format!("read key: {e}"))?;

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| format!("load root CA: {e}"))?;

    let server_config = root_ca.create_server_config(&storage)
        .map_err(|e| format!("create server config: {e}"))?;

    Ok(Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
    }))
}
