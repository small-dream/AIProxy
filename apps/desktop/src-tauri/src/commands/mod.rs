use crate::bootstrap::{AppState, BootstrapStatus, CertificateStateSnapshot, RuntimeHandles};
use crate::dev_logger::{log_debug, log_error, log_info, log_warn};
use crate::system_proxy::{
    apply_system_proxy_settings, capture_system_proxy_snapshot, restore_system_proxy,
    SystemProxySettings,
};
use crate::workspace::WorkspaceData;
use pharles_proxy_core::{
    get_local_ip_addresses, send_direct_request, start_proxy_server,
    BreakpointEventEmitter, BreakpointResolution, BreakpointRule, MapRule,
    ProxyRuntimeConfig, ProxyHeaderEntry, ProxySessionDetail, ProxySessionSummary,
    RewriteRule, ThrottleProfileData, TlsManager,
};
use pharles_tls_manager::{detect_platform, is_cert_trusted_on_platform, CertStorage, RootCaPair};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbInstallResult {
    pub success: bool,
    pub device_serial: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAndroidCertificateViaAdbInput {
    pub device_serial: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsExceptInput {
    pub keep_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFocusedHostInput {
    pub host: Option<String>,
}

#[tauri::command]
pub fn delete_sessions_except(
    input: DeleteSessionsExceptInput,
    state: State<'_, Arc<AppState>>,
) {
    state.delete_sessions_except(&input.keep_session_id);
}

#[tauri::command]
pub fn set_focused_host(
    input: SetFocusedHostInput,
    state: State<'_, Arc<AppState>>,
) {
    state.set_focused_host(input.host);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendComposedRequestInput {
    #[allow(dead_code)]
    pub workspace_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: Option<String>,
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
pub fn launch_certificate_installer(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    launch_certificate_installer_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn list_android_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    list_android_adb_devices_impl()
}

#[tauri::command]
pub fn install_android_certificate_via_adb(
    input: InstallAndroidCertificateViaAdbInput,
    state: State<'_, Arc<AppState>>,
) -> Result<AndroidAdbInstallResult, String> {
    install_android_certificate_via_adb_impl(input, Arc::clone(state.inner()))
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

#[tauri::command]
pub async fn send_composed_request(
    input: SendComposedRequestInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ProxySessionDetail, String> {
    let detail = send_direct_request(input.method, input.url, input.headers, input.body).await?;
    let session_id = detail.id.clone();
    state.upsert_session(detail.clone());

    log_info(
        "desktop.commands",
        "send_composed_request_succeeded",
        &[
            ("session_id", session_id),
            (
                "status_code",
                detail.summary.status_code.to_string(),
            ),
        ],
    );

    Ok(detail)
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

    if shutdown_proxy_runtime(Arc::clone(&state)).await {
        log_debug(
            "desktop.commands",
            "previous_proxy_runtime_found",
            &[("workspace_id", input.workspace_id.clone())],
        );
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

    let breakpoint_manager = state.read_breakpoint_manager();

    let event_emitter: Option<BreakpointEventEmitter> = state.read_app_handle().map(|handle| {
        Arc::new(move |event: &str, payload: serde_json::Value| {
            let _ = handle.emit(event, payload);
        }) as BreakpointEventEmitter
    });

    let started_proxy_server = start_proxy_server(
        ProxyRuntimeConfig {
            port,
            ssl_enabled: enable_ssl,
        },
        tls_manager,
        Some(breakpoint_manager),
        event_emitter,
    )
    .await?;

    let mut session_receiver = started_proxy_server.session_receiver;
    let state_for_collector = Arc::clone(&state);
    let collector_handle = tauri::async_runtime::spawn(async move {
        while let Some(session) = session_receiver.recv().await {
            state_for_collector.upsert_session(session);
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
    runtime_handles.proxy_server_handle.shutdown().await;
    runtime_handles.collector_handle.abort();
    let _ = runtime_handles.collector_handle.await;

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

    #[cfg(target_os = "macos")]
    storage
        .ensure_root_cert_install_copy()
        .map_err(|e| format!("failed to prepare installable root cert: {e}"))?;

    let trusted = is_cert_trusted_on_platform(storage.root_cert_path(), platform);
    let cert_path = certificate_display_path(&storage, platform);

    let status = CertificateStateSnapshot {
        cert_path: Some(cert_path),
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

    let status = get_certificate_status_impl(state)?;

    #[cfg(target_os = "macos")]
    if let Some(cert_path) = status.cert_path.as_deref() {
        if let Err(error) = open_certificate_file(cert_path) {
            log_warn(
                "desktop.commands",
                "generate_root_certificate_auto_open_failed",
                &[("error", error)],
            );
        }
    }

    Ok(status)
}

fn open_certificate_install_guide_impl(
    state: Arc<AppState>,
) -> Result<serde_json::Value, String> {
    let platform = detect_platform();
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status.cert_path.clone().unwrap_or_default();

    let steps = match platform {
        pharles_tls_manager::Platform::Windows => vec![
            serde_json::json!({"order": 1, "description": "Generate a root certificate, then click Install Certificate... to open the Windows certificate installer."}),
            serde_json::json!({"order": 2, "description": "In the dialog, click Install Certificate..."}),
            serde_json::json!({"order": 3, "description": "Select Current User or Local Machine (Local Machine requires administrator), then click Next."}),
            serde_json::json!({"order": 4, "description": "Select 'Place all certificates in the following store', click Browse, and choose Trusted Root Certification Authorities. Click Next."}),
            serde_json::json!({"order": 5, "description": "Click Finish. Accept the security warning to confirm trust."}),
            serde_json::json!({"order": 6, "description": "Click Refresh Status to verify the certificate is now trusted."}),
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

fn launch_certificate_installer_impl(state: Arc<AppState>) -> Result<(), String> {
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status
        .cert_path
        .ok_or_else(|| "No certificate found. Generate one first.".to_string())?;

    open_certificate_file(&cert_path)
}

fn list_android_adb_devices_impl() -> Result<Vec<AndroidAdbDevice>, String> {
    read_adb_devices()
}

fn install_android_certificate_via_adb_impl(
    input: InstallAndroidCertificateViaAdbInput,
    _state: Arc<AppState>,
) -> Result<AndroidAdbInstallResult, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("No certificate found. Generate one first.".to_string());
    }

    storage
        .ensure_root_cert_install_copy()
        .map_err(|e| format!("failed to prepare installable root cert: {e}"))?;

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let remote_path = "/sdcard/Download/pharles-root-ca.cer";

    let push_output = std::process::Command::new("adb")
        .args(["-s", &device_serial, "push"])
        .arg(storage.root_cert_install_path())
        .arg(remote_path)
        .output()
        .map_err(adb_spawn_error)?;

    if !push_output.status.success() {
        return Err(format!(
            "Failed to push certificate to Android device: {}",
            format_command_output(&push_output)
        ));
    }

    let launch_output = std::process::Command::new("adb")
        .args([
            "-s",
            &device_serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.credentials.INSTALL",
        ])
        .output()
        .map_err(adb_spawn_error)?;

    if !launch_output.status.success() {
        return Err(format!(
            "Failed to open the Android certificate installer entry: {}",
            format_command_output(&launch_output)
        ));
    }

    let launch_text = format_command_output(&launch_output);
    if launch_text.contains("Error:") {
        return Err(format!(
            "Android reported an error while opening the certificate installer entry: {}",
            launch_text
        ));
    }

    log_info(
        "desktop.commands",
        "install_android_certificate_via_adb_succeeded",
        &[
            ("device_serial", device_serial.clone()),
            ("remote_path", remote_path.to_string()),
        ],
    );

    Ok(AndroidAdbInstallResult {
        success: true,
        device_serial,
        remote_path: remote_path.to_string(),
    })
}

fn open_certificate_file(cert_path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["cryptext.dll,CryptExtOpenCER", &cert_path])
            .spawn()
            .map_err(|e| format!("Failed to open certificate installer: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Keychain Access", cert_path])
            .spawn()
            .map_err(|e| format!("Failed to open certificate in Keychain Access: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = cert_path;
        Err("Certificate launcher is only supported on Windows and macOS.".to_string())
    }
}

fn read_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    let output = std::process::Command::new("adb")
        .args(["devices", "-l"])
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to query adb devices: {}",
            format_command_output(&output)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let serial = parts.next().unwrap_or_default();
        let state = parts.next().unwrap_or_default();

        if serial.is_empty() || state.is_empty() {
            continue;
        }

        let mut model = None;
        let mut product = None;
        let mut device = None;
        let mut transport_id = None;

        for segment in parts {
            if let Some(value) = segment.strip_prefix("model:") {
                model = Some(value.replace('_', " "));
                continue;
            }

            if let Some(value) = segment.strip_prefix("product:") {
                product = Some(value.to_string());
                continue;
            }

            if let Some(value) = segment.strip_prefix("device:") {
                device = Some(value.to_string());
                continue;
            }

            if let Some(value) = segment.strip_prefix("transport_id:") {
                transport_id = Some(value.to_string());
            }
        }

        devices.push(AndroidAdbDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
            product,
            device,
            transport_id,
        });
    }

    Ok(devices)
}

fn resolve_adb_target_device(requested_serial: Option<&str>) -> Result<String, String> {
    let devices = read_adb_devices()?;
    let ready_devices = devices
        .iter()
        .filter(|device| device.state == "device")
        .collect::<Vec<_>>();

    if let Some(requested_serial) = requested_serial {
        let Some(device) = devices.iter().find(|device| device.serial == requested_serial) else {
            return Err(format!(
                "Android device `{requested_serial}` was not found in adb devices. Refresh the device list and try again."
            ));
        };

        if device.state != "device" {
            return Err(format!(
                "Android device `{requested_serial}` is in `{}` state. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
                device.state
            ));
        }

        return Ok(device.serial.clone());
    }

    if ready_devices.is_empty() {
        let unavailable_devices = devices
            .iter()
            .map(|device| format!("{} ({})", device.serial, device.state))
            .collect::<Vec<_>>();

        if unavailable_devices.is_empty() {
            return Err(
                "No Android device found via adb. Connect one device and enable USB debugging, then try again."
                    .to_string(),
            );
        }

        return Err(format!(
            "No ready Android device found via adb. Current device states: {}. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
            unavailable_devices.join(", ")
        ));
    }

    if ready_devices.len() > 1 {
        return Err(format!(
            "Multiple ready Android devices are connected via adb ({}). Choose one device in the Certificates page, then try again.",
            ready_devices
                .iter()
                .map(|device| device.serial.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(ready_devices[0].serial.clone())
}

fn adb_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return "adb was not found in PATH. Install Android Platform Tools and make sure the `adb` command is available.".to_string();
    }

    format!("failed to run adb: {error}")
}

fn format_command_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}; {stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => "no output".to_string(),
    }
}

fn certificate_display_path(storage: &CertStorage, platform: pharles_tls_manager::Platform) -> String {
    match platform {
        pharles_tls_manager::Platform::Macos => storage
            .root_cert_install_path()
            .to_string_lossy()
            .to_string(),
        _ => storage.root_cert_path().to_string_lossy().to_string(),
    }
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

// --- Breakpoint commands ---

#[tauri::command]
pub fn list_breakpoint_rules(state: State<'_, Arc<AppState>>) -> Vec<BreakpointRule> {
    state.read_breakpoint_manager().list_rules()
}

#[tauri::command]
pub fn set_breakpoint_rules(rules: Vec<BreakpointRule>, state: State<'_, Arc<AppState>>) {
    state.read_breakpoint_manager().set_rules(rules);
}

#[tauri::command]
pub fn resolve_breakpoint(
    resolution: BreakpointResolution,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let session_id = resolution.session_id.clone();
    state
        .read_breakpoint_manager()
        .resolve(&session_id, resolution)
}

// --- Rewrite commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRewriteRulesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_rewrite_rules(
    input: ListRewriteRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<RewriteRule> {
    state.read_rewrite_manager().list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_rewrite_rule(
    input: RewriteRule,
    state: State<'_, Arc<AppState>>,
) -> RewriteRule {
    state.read_rewrite_manager().save_rule(input)
}

// --- Map commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMapRulesInput {
    pub workspace_id: String,
    pub mode: Option<String>,
}

#[tauri::command]
pub fn list_map_rules(
    input: ListMapRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<MapRule> {
    state.read_map_manager().list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .filter(|r| match &input.mode {
            Some(mode) => r.mode == *mode,
            None => true,
        })
        .collect()
}

#[tauri::command]
pub fn save_map_rule(
    input: MapRule,
    state: State<'_, Arc<AppState>>,
) -> MapRule {
    state.read_map_manager().save_rule(input)
}

// --- Delete rule (shared for rewrite/map) ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRuleInput {
    pub rule_id: String,
    pub rule_type: String,
}

#[tauri::command]
pub fn delete_rule(
    input: DeleteRuleInput,
    state: State<'_, Arc<AppState>>,
) {
    match input.rule_type.as_str() {
        "rewrite" => state.read_rewrite_manager().delete_rule(&input.rule_id),
        "map" => state.read_map_manager().delete_rule(&input.rule_id),
        _ => {}
    }
}

// --- Throttle commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottleProfilesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_throttle_profiles(
    input: ListThrottleProfilesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<ThrottleProfileData> {
    state.read_throttle_manager().list_profiles()
        .into_iter()
        .filter(|p| p.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_throttle_profile(
    input: ThrottleProfileData,
    state: State<'_, Arc<AppState>>,
) -> ThrottleProfileData {
    state.read_throttle_manager().save_profile(input)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveThrottleProfileInput {
    pub workspace_id: String,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub fn set_active_throttle_profile(
    input: SetActiveThrottleProfileInput,
    state: State<'_, Arc<AppState>>,
) {
    state.read_throttle_manager().set_active_profile(
        &input.workspace_id,
        input.profile_id.as_deref(),
    );
}

// --- Workspace commands ---

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
    let ssl_enabled = input.ssl_enabled.unwrap_or(false);

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
        input.name,
        input.proxy_port,
        input.ssl_enabled,
    )?;

    log_info(
        "desktop.commands",
        "update_workspace_succeeded",
        &[("workspace_id", workspace.id.clone())],
    );

    Ok(workspace)
}
