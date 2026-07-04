use super::common::*;
use aiproxy_sys_util::CommandExt;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAdbProxyResult {
    pub success: bool,
    pub device_serial: String,
    pub proxy_address: Option<String>,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorDevice {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub runtime: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorInstallResult {
    pub success: bool,
    pub simulator_name: String,
    pub simulator_udid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIosCertificateViaSimulatorInput {
    pub simulator_udid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAndroidProxyViaAdbInput {
    pub device_serial: Option<String>,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAndroidProxyViaAdbInput {
    pub device_serial: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarmonyHdcInstallResult {
    pub success: bool,
    pub device_serial: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HarmonyHdcDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHarmonyCertificateViaHdcInput {
    pub device_serial: Option<String>,
}

#[tauri::command]
pub fn get_certificate_status(
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    get_certificate_status_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub async fn generate_root_certificate(
    input: GenerateRootCertificateInput,
    state: State<'_, Arc<AppState>>,
) -> Result<CertificateStateSnapshot, String> {
    generate_root_certificate_impl(input, Arc::clone(state.inner())).await
}

#[tauri::command]
pub fn open_certificate_install_guide(
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    open_certificate_install_guide_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub fn launch_certificate_installer(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    launch_certificate_installer_impl(Arc::clone(state.inner()))
}

#[tauri::command]
pub async fn list_android_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    run_blocking_command("list_android_adb_devices", list_android_adb_devices_impl).await
}

#[tauri::command]
pub async fn install_android_certificate_via_adb(
    input: InstallAndroidCertificateViaAdbInput,
    state: State<'_, Arc<AppState>>,
) -> Result<AndroidAdbInstallResult, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("install_android_certificate_via_adb", move || {
        install_android_certificate_via_adb_impl(input, state)
    })
    .await
}

#[tauri::command]
pub async fn list_ios_simulators() -> Result<Vec<IosSimulatorDevice>, String> {
    run_blocking_command("list_ios_simulators", list_ios_simulators_impl).await
}

#[tauri::command]
pub async fn install_ios_certificate_via_simulator(
    input: InstallIosCertificateViaSimulatorInput,
    state: State<'_, Arc<AppState>>,
) -> Result<IosSimulatorInstallResult, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("install_ios_certificate_via_simulator", move || {
        install_ios_certificate_via_simulator_impl(input, state)
    })
    .await
}

#[tauri::command]
pub async fn set_android_proxy_via_adb(
    input: SetAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    run_blocking_command("set_android_proxy_via_adb", move || {
        set_android_proxy_via_adb_impl(input)
    })
    .await
}

#[tauri::command]
pub async fn clear_android_proxy_via_adb(
    input: ClearAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    run_blocking_command("clear_android_proxy_via_adb", move || {
        clear_android_proxy_via_adb_impl(input)
    })
    .await
}

#[tauri::command]
pub async fn list_harmony_hdc_devices() -> Result<Vec<HarmonyHdcDevice>, String> {
    run_blocking_command("list_harmony_hdc_devices", list_harmony_hdc_devices_impl).await
}

#[tauri::command]
pub async fn install_harmony_certificate_via_hdc(
    input: InstallHarmonyCertificateViaHdcInput,
    state: State<'_, Arc<AppState>>,
) -> Result<HarmonyHdcInstallResult, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("install_harmony_certificate_via_hdc", move || {
        install_harmony_certificate_via_hdc_impl(input, state)
    })
    .await
}

fn get_certificate_status_impl(state: Arc<AppState>) -> Result<CertificateStateSnapshot, String> {
    let platform = detect_platform();

    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

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

    let cert_pem = storage
        .load_root_cert_pem()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to read root cert: {e}")))?;
    let key_pem = storage
        .load_root_key_pem()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to read root key: {e}")))?;

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to load root CA: {e}")))?;

    #[cfg(target_os = "macos")]
    storage.ensure_root_cert_install_copy().map_err(|e| {
        app_error(
            ERR_INTERNAL,
            format!("failed to prepare installable root cert: {e}"),
        )
    })?;

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

/// A single structured diagnostic check surfaced to the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub key: String,
    pub ok: bool,
    pub message: Option<String>,
}

/// Structured certificate/proxy setup diagnostic. Aggregates the probes the
/// first-run flow cares about (cert present/readable/trusted, adb available,
/// hdc available, iOS Simulator tooling) so the UI can render actionable
/// guidance without re-deriving platform specifics. Reuses existing
/// tls-manager probes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDiagnostic {
    pub platform: String,
    pub cert_present: bool,
    pub cert_path: Option<String>,
    pub cert_trusted: bool,
    pub adb_available: bool,
    pub hdc_available: bool,
    pub ios_simulator_tooling: bool,
    pub checks: Vec<DiagnosticCheck>,
}

#[tauri::command]
pub fn diagnose_certificate_setup() -> Result<SetupDiagnostic, String> {
    let platform = detect_platform();

    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

    let cert_present = storage.root_cert_exists();
    let cert_path = if cert_present {
        Some(certificate_display_path(&storage, platform))
    } else {
        None
    };
    let cert_trusted = if cert_present {
        is_cert_trusted_on_platform(storage.root_cert_path(), platform)
    } else {
        false
    };
    let adb_available = resolve_adb_path().is_ok();
    let hdc_available = resolve_hdc_path().is_ok();
    let ios_simulator_tooling = ios_simctl_available();

    let mut checks = Vec::new();
    checks.push(DiagnosticCheck {
        key: "cert_present".into(),
        ok: cert_present,
        message: if cert_present {
            None
        } else {
            Some("No root certificate found. Generate one first.".into())
        },
    });
    checks.push(DiagnosticCheck {
        key: "cert_trusted".into(),
        ok: cert_trusted,
        message: if cert_trusted {
            None
        } else if cert_present {
            Some("Certificate exists but is not trusted on this platform. Complete the platform trust step.".into())
        } else {
            None
        },
    });
    checks.push(DiagnosticCheck {
        key: "adb".into(),
        ok: adb_available,
        message: if adb_available {
            None
        } else {
            Some(
                "adb was not found. Install Android Platform Tools to use Android quick actions."
                    .into(),
            )
        },
    });
    checks.push(DiagnosticCheck {
        key: "hdc".into(),
        ok: hdc_available,
        message: if hdc_available {
            None
        } else {
            Some("hdc was not found. Install HarmonyOS SDK / DevEco Studio to use HarmonyOS quick actions.".into())
        },
    });
    #[cfg(target_os = "macos")]
    checks.push(DiagnosticCheck {
        key: "ios_simulator".into(),
        ok: ios_simulator_tooling,
        message: if ios_simulator_tooling {
            None
        } else {
            Some(
                "xcrun simctl is unavailable. Install Xcode to use iOS Simulator quick actions."
                    .into(),
            )
        },
    });

    Ok(SetupDiagnostic {
        platform: platform.to_string(),
        cert_present,
        cert_path,
        cert_trusted,
        adb_available,
        hdc_available,
        ios_simulator_tooling,
        checks,
    })
}

/// Whether `xcrun simctl` is available (macOS only). On other platforms this is
/// always false — iOS Simulator tooling requires macOS + Xcode.
fn ios_simctl_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("xcrun")
            .args(["simctl", "list", "devices", "--json"])
            .no_window()
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

async fn generate_root_certificate_impl(
    input: GenerateRootCertificateInput,
    state: Arc<AppState>,
) -> Result<CertificateStateSnapshot, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

    // If already exists and not forcing regeneration, return existing status
    if storage.root_cert_exists() && !input.force_regenerate.unwrap_or(false) {
        return get_certificate_status_impl(state);
    }

    // Generate new root CA
    let root_ca = RootCaPair::generate()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to generate root CA: {e}")))?;

    storage
        .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to save root CA: {e}")))?;

    // Create server config for MITM
    let h2 = true; // default on for cert generation; actual runtime setting used at proxy start
    let alpn = if h2 {
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    } else {
        vec![b"http/1.1".to_vec()]
    };
    let server_config = root_ca
        .create_server_config(&storage, Some(alpn))
        .map_err(|e| {
            app_error(
                ERR_INTERNAL,
                format!("failed to create TLS server config: {e}"),
            )
        })?;

    // Store TlsManager in AppState
    let tls_manager = Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
        http2_enabled: h2,
    });

    // M8 + Finding #1: a root-CA rotation must invalidate certs the running
    // proxy can still serve. Two layers:
    //  (a) Flush the previous manager's host cert cache (shared via Arc across
    //      any in-flight CertStorage clones), so cached leaf certs signed by the
    //      OLD root are not re-served.
    //  (b) Restart the proxy if it is running. The running proxy captured an
    //      `Arc<TlsManager>` at start time, whose `ServerConfig` embeds a
    //      `DynamicCertResolver` holding the OLD `root_ca_sign_data`. Flushing
    //      the cache alone would make that resolver RE-SIGN with the old root —
    //      so the server config must be rebuilt from the new manager. A restart
    //      is the only correct option because rustls `ServerConfig` (and its
    //      cert resolver) is immutable after construction. Existing TLS
    //      sessions are interrupted, which is expected: a rotation invalidates
    //      the trust anchor clients validated against.
    if let Some(previous) = state.read_tls_manager() {
        previous.storage.clear_host_cache();
    }

    state.set_tls_manager(tls_manager);

    if state.read_status().running {
        if let Err(error) = super::proxy::restart_proxy_if_running(Arc::clone(&state)).await {
            tracing::error!(
                component = "desktop.commands",
                event = "restart_proxy_after_root_rotation_failed",
                error = %error,
                "restart_proxy_after_root_rotation_failed"
            );
            return Err(error);
        }
    }

    let status = get_certificate_status_impl(state)?;

    #[cfg(target_os = "macos")]
    if let Some(cert_path) = status.cert_path.as_deref() {
        if let Err(error) = open_certificate_file(cert_path) {
            tracing::warn!(
                component = "desktop.commands",
                event = "generate_root_certificate_auto_open_failed",
                error = %error,
                "generate_root_certificate_auto_open_failed"
            );
        }
    }

    Ok(status)
}

fn open_certificate_install_guide_impl(state: Arc<AppState>) -> Result<serde_json::Value, String> {
    let platform = detect_platform();
    let cert_status = get_certificate_status_impl(state)?;
    let cert_path = cert_status.cert_path.clone().unwrap_or_default();

    let steps = match platform {
        aiproxy_tls_manager::Platform::Windows => vec![
            serde_json::json!({"order": 1, "description": "Generate a root certificate, then click Install Certificate... to open the Windows certificate installer."}),
            serde_json::json!({"order": 2, "description": "In the dialog, click Install Certificate..."}),
            serde_json::json!({"order": 3, "description": "Select Current User or Local Machine (Local Machine requires administrator), then click Next."}),
            serde_json::json!({"order": 4, "description": "Select 'Place all certificates in the following store', click Browse, and choose Trusted Root Certification Authorities. Click Next."}),
            serde_json::json!({"order": 5, "description": "Click Finish. Accept the security warning to confirm trust."}),
            serde_json::json!({"order": 6, "description": "Click Refresh Status to verify the certificate is now trusted."}),
        ],
        aiproxy_tls_manager::Platform::Macos => vec![
            serde_json::json!({"order": 1, "description": format!("Double-click the certificate file at: {}", cert_path)}),
            serde_json::json!({"order": 2, "description": "Open Keychain Access. The certificate will appear in the 'login' keychain."}),
            serde_json::json!({"order": 3, "description": "Drag the certificate to the 'System' keychain in the left sidebar."}),
            serde_json::json!({"order": 4, "description": "Double-click the certificate in System keychain, expand Trust, and set 'When using this certificate' to 'Always Trust'."}),
            serde_json::json!({"order": 5, "description": "Close the window. You will be prompted for your administrator password."}),
            serde_json::json!({"order": 6, "description": "Restart your browser for the change to take effect."}),
        ],
        aiproxy_tls_manager::Platform::Linux => vec![
            serde_json::json!({"order": 1, "description": format!("Copy the certificate to the system CA directory: sudo cp {} /usr/local/share/ca-certificates/aiproxy-root-ca.crt", cert_path)}),
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
    let cert_path = cert_status.cert_path.ok_or_else(|| {
        app_error(
            ERR_CERT_NOT_FOUND,
            "No certificate found. Generate one first.",
        )
    })?;

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
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

    if !storage.root_cert_exists() {
        return Err(app_error(
            ERR_CERT_NOT_FOUND,
            "No certificate found. Generate one first.",
        ));
    }

    storage.ensure_root_cert_install_copy().map_err(|e| {
        app_error(
            ERR_INTERNAL,
            format!("failed to prepare installable root cert: {e}"),
        )
    })?;

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    // Push as `.crt` (not `.cer`) and nudge MediaStore afterward. Android's
    // "Install from storage" file picker reads from MediaStore, which a raw
    // `adb push` does NOT refresh, and OEM cert pickers recognize `.crt` far
    // more reliably than `.cer`. Both come for free on the browser-download
    // path (http://<ip>:<port>/aiproxy-ca.crt) via the download manager, which
    // is why that route installs cleanly while a raw push ended up invisible
    // or "unable to install". Match that route's filename exactly.
    let remote_path = "/sdcard/Download/aiproxy-ca.crt";

    let adb = resolve_adb_path()?;
    let push_output = std::process::Command::new(&adb)
        .args(["-s", &device_serial, "push"])
        .arg(storage.root_cert_install_path())
        .arg(remote_path)
        .no_window()
        .output()
        .map_err(adb_spawn_error)?;

    if !push_output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to push certificate to Android device: {}",
                format_command_output(&push_output)
            ),
        ));
    }

    // Best-effort: ask MediaStore to index the freshly pushed file so the
    // "Install from storage" picker lists it. The broadcast is honored on
    // Android <= 10 and silently ignored on some 11+ builds, so failure here
    // is non-fatal — the file is still on disk and reachable manually. Never
    // block the install flow on this.
    let scan_uri = format!("file://{remote_path}");
    match std::process::Command::new(&adb)
        .args([
            "-s",
            &device_serial,
            "shell",
            "am",
            "broadcast",
            "-a",
            "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
            "-d",
            &scan_uri,
        ])
        .no_window()
        .output()
    {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            tracing::warn!(
                component = "desktop.commands",
                event = "android_media_scan_non_success",
                device_serial = %device_serial,
                output = %format_command_output(&output),
                "media scan broadcast reported non-success; the pushed file may not appear in the Install-from-storage picker"
            );
        }
        Err(error) => {
            tracing::warn!(
                component = "desktop.commands",
                event = "android_media_scan_spawn_failed",
                device_serial = %device_serial,
                error = %error,
                "media scan broadcast failed to spawn; the pushed file may not appear in the Install-from-storage picker"
            );
        }
    }

    let launch_output = std::process::Command::new(&adb)
        .args([
            "-s",
            &device_serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.settings.SECURITY_SETTINGS",
        ])
        .no_window()
        .output()
        .map_err(adb_spawn_error)?;

    if !launch_output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to open Android Security settings: {}",
                format_command_output(&launch_output)
            ),
        ));
    }

    let launch_text = format_command_output(&launch_output);
    if launch_text.contains("Error:") {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Android reported an error while opening Security settings: {}",
                launch_text
            ),
        ));
    }

    tracing::info!(
        component = "desktop.commands",
        event = "install_android_certificate_via_adb_succeeded",
        device_serial = %device_serial,
        remote_path = %remote_path,
        "install_android_certificate_via_adb_succeeded"
    );

    Ok(AndroidAdbInstallResult {
        success: true,
        device_serial,
        remote_path: remote_path.to_string(),
    })
}

fn list_ios_simulators_impl() -> Result<Vec<IosSimulatorDevice>, String> {
    read_ios_simulators()
}

fn install_ios_certificate_via_simulator_impl(
    input: InstallIosCertificateViaSimulatorInput,
    _state: Arc<AppState>,
) -> Result<IosSimulatorInstallResult, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

    if !storage.root_cert_exists() {
        return Err(app_error(
            ERR_CERT_NOT_FOUND,
            "No certificate found. Generate one first.",
        ));
    }

    let simulator = resolve_ios_simulator(input.simulator_udid.as_deref())?;

    let output = std::process::Command::new("xcrun")
        .args(["simctl", "keychain", &simulator.udid, "add-root-cert"])
        .arg(storage.root_cert_path())
        .no_window()
        .output()
        .map_err(xcrun_spawn_error)?;

    if !output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to install the root certificate into iOS Simulator `{}`: {}",
                simulator.name,
                format_command_output(&output)
            ),
        ));
    }

    tracing::info!(
        component = "desktop.commands",
        event = "install_ios_certificate_via_simulator_succeeded",
        simulator_name = %simulator.name,
        simulator_udid = %simulator.udid,
        "install_ios_certificate_via_simulator_succeeded"
    );

    Ok(IosSimulatorInstallResult {
        success: true,
        simulator_name: simulator.name,
        simulator_udid: simulator.udid,
    })
}

fn set_android_proxy_via_adb_impl(
    input: SetAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    let host = input.host.trim();
    if host.is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "Android proxy host cannot be empty.",
        ));
    }

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let proxy_address = format!("{host}:{}", input.port);

    run_adb_shell_command(
        &device_serial,
        &["settings", "put", "global", "http_proxy", &proxy_address],
    )?;

    tracing::info!(
        component = "desktop.commands",
        event = "set_android_proxy_via_adb_succeeded",
        device_serial = %device_serial,
        proxy_address = %proxy_address,
        "set_android_proxy_via_adb_succeeded"
    );

    Ok(AndroidAdbProxyResult {
        success: true,
        device_serial,
        proxy_address: Some(proxy_address),
    })
}

fn clear_android_proxy_via_adb_impl(
    input: ClearAndroidProxyViaAdbInput,
) -> Result<AndroidAdbProxyResult, String> {
    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;

    run_adb_shell_command(
        &device_serial,
        &["settings", "put", "global", "http_proxy", ":0"],
    )?;

    tracing::info!(
        component = "desktop.commands",
        event = "clear_android_proxy_via_adb_succeeded",
        device_serial = %device_serial,
        "clear_android_proxy_via_adb_succeeded"
    );

    Ok(AndroidAdbProxyResult {
        success: true,
        device_serial,
        proxy_address: None,
    })
}

fn list_harmony_hdc_devices_impl() -> Result<Vec<HarmonyHdcDevice>, String> {
    read_hdc_devices()
}

/// Push the root certificate to a HarmonyOS NEXT device via hdc, then attempt
/// to open the system certificate manager so the user can complete the manual
/// install (HarmonyOS NEXT has no adb-style `am install` equivalent that
/// trusts a user CA in one shot — the user must finish via
/// Settings → Security → Encryption & credentials → Install from storage).
///
/// The cert is pushed to the user-visible Downloads directory so the system
/// file picker can see it during "Install from storage". The `100` segment is
/// the default single-user id on HarmonyOS NEXT.
fn install_harmony_certificate_via_hdc_impl(
    input: InstallHarmonyCertificateViaHdcInput,
    _state: Arc<AppState>,
) -> Result<HarmonyHdcInstallResult, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("failed to resolve cert storage: {e}")))?;

    if !storage.root_cert_exists() {
        return Err(app_error(
            ERR_CERT_NOT_FOUND,
            "No certificate found. Generate one first.",
        ));
    }

    storage.ensure_root_cert_install_copy().map_err(|e| {
        app_error(
            ERR_INTERNAL,
            format!("failed to prepare installable root cert: {e}"),
        )
    })?;

    let device_serial = resolve_harmony_target_device(input.device_serial.as_deref())?;
    // Push into the user-visible Downloads directory so the system file picker
    // can reach it during "Install from storage". `/data/local/tmp/` is not
    // visible to the picker, which forced users to fall back to QR/browser.
    let remote_path = "/storage/media/100/local/files/Download/aiproxy-root-ca.cer";

    let hdc = resolve_hdc_path()?;
    let push_output = std::process::Command::new(&hdc)
        .args(["-t", &device_serial, "file", "send"])
        .arg(storage.root_cert_install_path())
        .arg(remote_path)
        .no_window()
        .output()
        .map_err(hdc_spawn_error)?;

    if !push_output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to push certificate to HarmonyOS device: {}",
                format_command_output(&push_output)
            ),
        ));
    }

    // Best-effort: open the system certificate manager so the user can go
    // straight to "Install from storage". `com.ohos.certmanager` is the
    // built-in cert manager on HarmonyOS NEXT; the exact bundle/ability can
    // differ across device builds, so we log a warning instead of failing
    // when this is unavailable. The push above is the authoritative success
    // criterion.
    let launch_output = std::process::Command::new(&hdc)
        .args([
            "-t",
            &device_serial,
            "shell",
            "aa",
            "start",
            "-a",
            "MainAbility",
            "-b",
            "com.ohos.certmanager",
        ])
        .no_window()
        .output();

    if let Ok(output) = &launch_output {
        if !output.status.success() {
            tracing::warn!(
                component = "desktop.commands",
                event = "install_harmony_open_settings_failed",
                device_serial = %device_serial,
                output = %format_command_output(output),
                "opening HarmonyOS settings failed; user must open it manually"
            );
        }
    }

    tracing::info!(
        component = "desktop.commands",
        event = "install_harmony_certificate_via_hdc_succeeded",
        device_serial = %device_serial,
        remote_path = %remote_path,
        "install_harmony_certificate_via_hdc_succeeded"
    );

    Ok(HarmonyHdcInstallResult {
        success: true,
        device_serial,
        remote_path: remote_path.to_string(),
    })
}

#[allow(clippy::needless_return)] // cfg-gated early returns per platform are required.
fn open_certificate_file(cert_path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["cryptext.dll,CryptExtOpenCER", cert_path])
            .no_window()
            .spawn()
            .map_err(|e| {
                app_error(
                    ERR_INTERNAL,
                    format!("Failed to open certificate installer: {e}"),
                )
            })?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Keychain Access", cert_path])
            .no_window()
            .spawn()
            .map_err(|e| {
                app_error(
                    ERR_INTERNAL,
                    format!("Failed to open certificate in Keychain Access: {e}"),
                )
            })?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(cert_path)
            .no_window()
            .spawn()
            .map_err(|e| {
                app_error(
                    ERR_INTERNAL,
                    format!("Failed to open certificate file: {e}"),
                )
            })?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = cert_path;
        Err(app_error(
            ERR_INVALID_INPUT,
            "Certificate launcher is not supported on this platform.",
        ))
    }
}

fn read_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
        .args(["devices", "-l"])
        .no_window()
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to query adb devices: {}",
                format_command_output(&output)
            ),
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

/// Parse `hdc list targets -v` output into HarmonyOS devices.
///
/// Verbose output includes the transport before the state, e.g.
/// `127.0.0.1:5555 TCP Connected localhost hdc`. Some hdc builds print only
/// the serial in non-verbose mode; those rows are treated as connected because
/// hdc only lists reachable targets there.
fn read_hdc_devices() -> Result<Vec<HarmonyHdcDevice>, String> {
    let hdc = resolve_hdc_path()?;
    let output = std::process::Command::new(&hdc)
        .args(["list", "targets", "-v"])
        .no_window()
        .output()
        .map_err(hdc_spawn_error)?;

    if !output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to query hdc devices: {}",
                format_command_output(&output)
            ),
        ));
    }

    Ok(parse_hdc_devices_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_hdc_devices_output(stdout: &str) -> Vec<HarmonyHdcDevice> {
    let mut devices = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("[Empty]") {
            continue;
        }

        let parts = trimmed.split_whitespace().collect::<Vec<_>>();
        let Some(serial) = parts.first().copied() else {
            continue;
        };

        let state_index = parts
            .iter()
            .position(|part| is_hdc_device_state(part))
            .unwrap_or(1);
        let state = parts.get(state_index).copied().unwrap_or("Connected");

        let model = parts.iter().skip(state_index + 1).find_map(|segment| {
            segment
                .strip_prefix("model:")
                .map(str::to_string)
                .or_else(|| {
                    if *segment != "hdc" {
                        Some((*segment).to_string())
                    } else {
                        None
                    }
                })
        });

        devices.push(HarmonyHdcDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
        });
    }

    devices
}

fn is_hdc_device_state(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "connected" | "offline" | "unauthorized" | "unknown" | "disconnected"
    )
}

#[allow(clippy::needless_return)] // cfg-gated early returns per platform are required.
fn read_ios_simulators() -> Result<Vec<IosSimulatorDevice>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "iOS Simulator quick actions are only supported on macOS.",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("xcrun")
            .args(["simctl", "list", "devices", "available", "--json"])
            .no_window()
            .output()
            .map_err(xcrun_spawn_error)?;

        if !output.status.success() {
            return Err(app_error(
                ERR_INTERNAL,
                format!(
                    "Failed to query iOS Simulators: {}",
                    format_command_output(&output)
                ),
            ));
        }

        let payload: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|error| {
                app_error(
                    ERR_INTERNAL,
                    format!("failed to parse simulator list: {error}"),
                )
            })?;
        let Some(devices_by_runtime) = payload.get("devices").and_then(|value| value.as_object())
        else {
            return Err(app_error(
                ERR_INTERNAL,
                "Simulator list did not include a devices map.",
            ));
        };

        let mut simulators = Vec::new();

        for (runtime_key, entries) in devices_by_runtime {
            let Some(entries) = entries.as_array() else {
                continue;
            };

            for entry in entries {
                let state = entry
                    .get("state")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                if state != "Booted" {
                    continue;
                }

                let is_available = entry
                    .get("isAvailable")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true);
                if !is_available {
                    continue;
                }

                let name = entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let udid = entry
                    .get("udid")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();

                if name.is_empty() || udid.is_empty() {
                    continue;
                }

                simulators.push(IosSimulatorDevice {
                    name: name.to_string(),
                    udid: udid.to_string(),
                    state: state.to_string(),
                    runtime: format_ios_runtime_name(runtime_key),
                });
            }
        }

        Ok(simulators)
    }
}

fn resolve_adb_target_device(requested_serial: Option<&str>) -> Result<String, String> {
    let devices = read_adb_devices()?;
    let ready_devices = devices
        .iter()
        .filter(|device| device.state == "device")
        .collect::<Vec<_>>();

    if let Some(requested_serial) = requested_serial {
        let Some(device) = devices
            .iter()
            .find(|device| device.serial == requested_serial)
        else {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!(
                    "Android device `{requested_serial}` was not found in adb devices. Refresh the device list and try again."
                ),
            ));
        };

        if device.state != "device" {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!(
                    "Android device `{requested_serial}` is in `{}` state. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
                    device.state
                ),
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
            return Err(app_error(
                ERR_INVALID_INPUT,
                "No Android device found via adb. Connect one device and enable USB debugging, then try again.",
            ));
        }

        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "No ready Android device found via adb. Current device states: {}. Unlock the phone, accept the USB debugging prompt if shown, then try again.",
                unavailable_devices.join(", ")
            ),
        ));
    }

    if ready_devices.len() > 1 {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Multiple ready Android devices are connected via adb ({}). Choose one device in the Certificates page, then try again.",
                ready_devices
                    .iter()
                    .map(|device| device.serial.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }

    Ok(ready_devices[0].serial.clone())
}

fn resolve_ios_simulator(requested_udid: Option<&str>) -> Result<IosSimulatorDevice, String> {
    let simulators = read_ios_simulators()?;

    if let Some(requested_udid) = requested_udid {
        let Some(simulator) = simulators
            .iter()
            .find(|simulator| simulator.udid == requested_udid)
        else {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!(
                    "iOS Simulator `{requested_udid}` was not found in the booted simulator list. Refresh the simulator list and try again."
                ),
            ));
        };

        return Ok(simulator.clone());
    }

    if simulators.is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "No booted iOS Simulator was found. Launch a simulator first, then try again.",
        ));
    }

    if simulators.len() > 1 {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Multiple booted iOS Simulators were found ({}). Choose one in the Mobile Setup page, then try again.",
                simulators
                    .iter()
                    .map(|simulator| simulator.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }

    Ok(simulators[0].clone())
}

/// Resolve the target HarmonyOS device serial, mirroring the adb logic.
/// A device is considered "ready" when its state is `Connected`. Offline or
/// unauthorized devices surface a dedicated, actionable error.
fn resolve_harmony_target_device(requested_serial: Option<&str>) -> Result<String, String> {
    let devices = read_hdc_devices()?;
    let ready_devices = devices
        .iter()
        .filter(|device| device.state == "Connected")
        .collect::<Vec<_>>();

    if let Some(requested_serial) = requested_serial {
        let Some(device) = devices
            .iter()
            .find(|device| device.serial == requested_serial)
        else {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!(
                    "HarmonyOS device `{requested_serial}` was not found in hdc devices. Refresh the device list and try again."
                ),
            ));
        };

        if device.state != "Connected" {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!(
                    "HarmonyOS device `{requested_serial}` is in `{}` state. Unlock the phone, enable USB debugging / HDC over USB in Developer options, then try again.",
                    device.state
                ),
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
            return Err(app_error(
                ERR_INVALID_INPUT,
                "No HarmonyOS device found via hdc. Connect one device and enable HDC debugging in Developer options, then try again.",
            ));
        }

        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "No ready HarmonyOS device found via hdc. Current device states: {}. Unlock the phone, enable HDC debugging in Developer options, then try again.",
                unavailable_devices.join(", ")
            ),
        ));
    }

    if ready_devices.len() > 1 {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Multiple ready HarmonyOS devices are connected via hdc ({}). Choose one device in the Certificates page, then try again.",
                ready_devices
                    .iter()
                    .map(|device| device.serial.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }

    Ok(ready_devices[0].serial.clone())
}

fn resolve_adb_path() -> Result<std::path::PathBuf, String> {
    // 1. Try bare "adb" from PATH
    if let Ok(output) = std::process::Command::new("adb")
        .arg("--version")
        .no_window()
        .output()
    {
        if output.status.success() {
            return Ok(std::path::PathBuf::from("adb"));
        }
    }

    // 2. Check ANDROID_HOME / ANDROID_SDK_ROOT
    for env_var in &["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(sdk_dir) = std::env::var(env_var) {
            let adb = std::path::Path::new(&sdk_dir)
                .join("platform-tools")
                .join("adb");
            if adb.exists() {
                return Ok(adb);
            }
        }
    }

    // 3. Check common install locations per platform
    if let Some(home) = dirs::home_dir() {
        let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
            vec![home.join("Library/Android/sdk/platform-tools/adb")]
        } else if cfg!(target_os = "linux") {
            vec![
                home.join("Android/Sdk/platform-tools/adb"),
                home.join(".android/sdk/platform-tools/adb"),
            ]
        } else {
            vec![]
        };

        for adb in candidates {
            if adb.exists() {
                return Ok(adb);
            }
        }
    }

    Err(app_error(ERR_INTERNAL, "adb was not found. Install Android Platform Tools (https://developer.android.com/tools/releases/platform-tools) and ensure `adb` is on PATH or ANDROID_HOME is set."))
}

fn adb_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return app_error(ERR_INTERNAL, "adb was not found in PATH. Install Android Platform Tools and make sure the `adb` command is available.");
    }

    app_error(ERR_INTERNAL, format!("failed to run adb: {error}"))
}

fn xcrun_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return app_error(ERR_INTERNAL, "xcrun was not found in PATH. Install Xcode Command Line Tools and make sure the `xcrun` command is available.");
    }

    app_error(ERR_INTERNAL, format!("failed to run xcrun: {error}"))
}

/// Locate the hdc (HarmonyOS Device Connector) binary, mirroring the adb
/// discovery chain:
///   1. bare `hdc` on PATH
///   2. `HDC_PATH` env var
///   3. DevEco Studio / HarmonyOS SDK common install locations per platform
fn resolve_hdc_path() -> Result<std::path::PathBuf, String> {
    // 1. Try bare "hdc" from PATH
    if let Ok(output) = std::process::Command::new("hdc")
        .arg("-v")
        .no_window()
        .output()
    {
        if output.status.success() {
            return Ok(std::path::PathBuf::from("hdc"));
        }
    }

    // 2. Check HDC_PATH. On Windows, also read persisted User/Machine
    // environment values because GUI processes can keep a stale environment
    // block until Explorer or the app is restarted.
    for path in hdc_path_env_values() {
        if let Some(hdc) = resolve_hdc_candidate_from_path(std::path::Path::new(&path)) {
            return Ok(hdc);
        }
    }

    // 3. Check common HarmonyOS SDK install locations per platform
    if let Some(home) = dirs::home_dir() {
        let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "macos") {
            vec![
                home.join("Library/Huawei/Sdk/*/toolchains/hdc"),
                home.join("Library/Huawei/Sdk/*/openharmony/toolchains/hdc"),
            ]
        } else if cfg!(target_os = "linux") {
            vec![home.join(".huawei/Sdk/*/openharmony/toolchains/hdc")]
        } else if cfg!(target_os = "windows") {
            let mut roots = vec![
                std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
                    .join("Huawei"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES").unwrap_or_default())
                    .join("Huawei"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES(X86)").unwrap_or_default())
                    .join("Huawei"),
            ];
            roots.retain(|root| root.exists());

            for root in &roots {
                if let Some(hdc) = find_hdc_binary_in_tree(root, 8) {
                    return Ok(hdc);
                }
            }

            vec![
                std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
                    .join("Huawei/Sdk/*/openharmony/toolchains/hdc.exe"),
                std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
                    .join("Huawei/Sdk/openharmony/*/toolchains/hdc.exe"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES").unwrap_or_default())
                    .join("Huawei/DevEco Studio/sdk/*/openharmony/toolchains/hdc.exe"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES").unwrap_or_default())
                    .join("Huawei/DevEco Studio/sdk/openharmony/*/toolchains/hdc.exe"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES(X86)").unwrap_or_default())
                    .join("Huawei/DevEco Studio/sdk/*/openharmony/toolchains/hdc.exe"),
                std::path::PathBuf::from(std::env::var("PROGRAMFILES(X86)").unwrap_or_default())
                    .join("Huawei/DevEco Studio/sdk/openharmony/*/toolchains/hdc.exe"),
            ]
        } else {
            vec![]
        };

        for pattern in candidates {
            // Patterns may contain a `*` glob segment (e.g. SDK version). Expand
            // by walking the parent dir and matching the trailing components.
            if let Some(matched) = expand_glob_path(&pattern) {
                return Ok(matched);
            }
        }
    }

    Err(app_error(ERR_INTERNAL, "hdc was not found. Install HarmonyOS SDK / DevEco Studio (https://developer.huawei.com/consumer/cn/download/) and ensure `hdc` is on PATH, or set HDC_PATH to the binary path (or its folder) and restart the app."))
}

fn hdc_path_env_values() -> Vec<String> {
    let mut values = Vec::new();

    if let Ok(path) = std::env::var("HDC_PATH") {
        push_unique_non_empty(&mut values, path);
    }

    #[cfg(target_os = "windows")]
    {
        for path in windows_hdc_path_registry_values() {
            push_unique_non_empty(&mut values, path);
        }
    }

    values
}

fn push_unique_non_empty(values: &mut Vec<String>, value: String) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }

    if !values.iter().any(|existing| existing == trimmed) {
        values.push(trimmed.to_string());
    }
}

#[cfg(target_os = "windows")]
fn windows_hdc_path_registry_values() -> Vec<String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
        RegKey,
    };

    let keys = [
        (HKEY_CURRENT_USER, r"Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ];

    keys.into_iter()
        .filter_map(|(root, subkey)| {
            RegKey::predef(root)
                .open_subkey_with_flags(subkey, KEY_READ)
                .ok()
                .and_then(|key| key.get_value::<String, _>("HDC_PATH").ok())
        })
        .collect()
}

/// Best-effort glob expansion for SDK paths containing a single `*` version
/// segment (e.g. `.../Sdk/*/toolchains/hdc`). Returns the first existing
/// match, preferring the lexicographically newest version.
fn expand_glob_path(pattern: &std::path::Path) -> Option<std::path::PathBuf> {
    let components: Vec<std::ffi::OsString> = pattern
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_os_string()),
            std::path::Component::RootDir => Some(std::ffi::OsString::from("/")),
            std::path::Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
            _ => None,
        })
        .collect();

    let star = std::ffi::OsString::from("*");
    let glob_index = components.iter().position(|component| component == &star)?;

    // Anchor = everything up to (not including) the `*` segment.
    let anchor: std::path::PathBuf = components[..glob_index].iter().collect();
    let suffix: std::path::PathBuf = components[glob_index + 1..].iter().collect();

    let entries = std::fs::read_dir(&anchor).ok()?;
    let mut matches: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let candidate_root = entry.path();
            let candidate = candidate_root.join(&suffix);
            if candidate.exists() {
                Some(candidate)
            } else {
                None
            }
        })
        .collect();

    // Prefer the newest version (lexicographically last).
    matches.sort();
    matches.pop()
}

fn resolve_hdc_candidate_from_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    if path.is_dir() {
        let candidates = if cfg!(target_os = "windows") {
            vec![path.join("hdc.exe"), path.join("bin").join("hdc.exe")]
        } else {
            vec![path.join("hdc"), path.join("bin").join("hdc")]
        };

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn find_hdc_binary_in_tree(root: &std::path::Path, max_depth: usize) -> Option<std::path::PathBuf> {
    use std::collections::VecDeque;

    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut matches = Vec::new();

    while let Some((dir, depth)) = queue.pop_front() {
        if depth > max_depth {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_file() {
                if is_hdc_binary(&path) {
                    matches.push(path);
                }
            } else if path.is_dir() && depth < max_depth {
                queue.push_back((path, depth + 1));
            }
        }
    }

    matches.sort();
    matches.pop()
}

fn is_hdc_binary(path: &std::path::Path) -> bool {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) if cfg!(target_os = "windows") => name.eq_ignore_ascii_case("hdc.exe"),
        Some(name) => name == "hdc",
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{stamp}"))
    }

    #[test]
    fn resolve_hdc_candidate_from_path_accepts_directory() {
        let dir = unique_temp_dir("hdc-path");
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let binary = if cfg!(target_os = "windows") {
            dir.join("hdc.exe")
        } else {
            dir.join("hdc")
        };
        std::fs::write(&binary, b"").expect("create temp binary");

        assert_eq!(resolve_hdc_candidate_from_path(&dir), Some(binary.clone()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_hdc_binary_matches_expected_filename() {
        let path = unique_temp_dir("hdc-binary-check").join(if cfg!(target_os = "windows") {
            "hdc.exe"
        } else {
            "hdc"
        });

        assert!(is_hdc_binary(&path));
    }

    #[test]
    fn parse_hdc_devices_output_accepts_verbose_emulator_row() {
        let devices =
            parse_hdc_devices_output("127.0.0.1:5555\t\tTCP\tConnected\tlocalhost\thdc\n");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].serial, "127.0.0.1:5555");
        assert_eq!(devices[0].state, "Connected");
        assert_eq!(devices[0].model.as_deref(), Some("localhost"));
    }

    #[test]
    fn parse_hdc_devices_output_treats_serial_only_rows_as_connected() {
        let devices = parse_hdc_devices_output("127.0.0.1:5555\n");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].serial, "127.0.0.1:5555");
        assert_eq!(devices[0].state, "Connected");
    }
}

fn hdc_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return app_error(ERR_INTERNAL, "hdc was not found in PATH. Install HarmonyOS SDK / DevEco Studio and make sure the `hdc` command is available.");
    }

    app_error(ERR_INTERNAL, format!("failed to run hdc: {error}"))
}

fn run_adb_shell_command(device_serial: &str, shell_args: &[&str]) -> Result<(), String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
        .args(["-s", device_serial, "shell"])
        .args(shell_args)
        .no_window()
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Failed to run `adb shell {}` on Android device `{}`: {}",
                shell_args.join(" "),
                device_serial,
                format_command_output(&output)
            ),
        ));
    }

    let output_text = format_command_output(&output);
    if output_text.contains("Exception occurred while executing")
        || output_text.starts_with("Error:")
    {
        return Err(app_error(
            ERR_INTERNAL,
            format!(
                "Android rejected `adb shell {}` on `{}`: {}",
                shell_args.join(" "),
                device_serial,
                output_text
            ),
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn format_ios_runtime_name(runtime_key: &str) -> String {
    let runtime = runtime_key
        .rsplit('.')
        .next()
        .unwrap_or(runtime_key)
        .replace('-', " ");

    if let Some(version) = runtime.strip_prefix("iOS ") {
        return format!("iOS {}", version.replace(' ', "."));
    }

    runtime
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

fn certificate_display_path(
    storage: &CertStorage,
    platform: aiproxy_tls_manager::Platform,
) -> String {
    match platform {
        aiproxy_tls_manager::Platform::Macos => storage
            .root_cert_install_path()
            .to_string_lossy()
            .to_string(),
        _ => storage.root_cert_path().to_string_lossy().to_string(),
    }
}

/// Try to load a TlsManager from an existing root CA on disk.
pub(super) fn try_load_tls_manager(http2_enabled: Option<bool>) -> Result<Arc<TlsManager>, String> {
    let storage = CertStorage::resolve()
        .map_err(|e| app_error(ERR_INTERNAL, format!("cert storage resolve: {e}")))?;

    if !storage.root_cert_exists() {
        return Err(app_error(ERR_CERT_NOT_FOUND, "no root certificate found"));
    }

    let cert_pem = storage
        .load_root_cert_pem()
        .map_err(|e| app_error(ERR_INTERNAL, format!("read cert: {e}")))?;
    let key_pem = storage
        .load_root_key_pem()
        .map_err(|e| app_error(ERR_INTERNAL, format!("read key: {e}")))?;

    // Migrate pre-existing installs: tighten permissions on a legacy key/dir
    // written before the current 0600/0700 baseline. Log and continue on
    // failure so an existing, working install can still start the proxy.
    if let Err(e) = storage.ensure_secure_permissions() {
        tracing::warn!(
            event = "tls_permissions_migration_failed",
            error = %e,
            "tls_permissions_migration_failed"
        );
    }

    let root_ca = RootCaPair::load_from_pem(&cert_pem, &key_pem)
        .map_err(|e| app_error(ERR_INTERNAL, format!("load root CA: {e}")))?;

    let h2 = http2_enabled.unwrap_or(true);
    let alpn = if h2 {
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    } else {
        vec![b"http/1.1".to_vec()]
    };
    let server_config = root_ca
        .create_server_config(&storage, Some(alpn))
        .map_err(|e| app_error(ERR_INTERNAL, format!("create server config: {e}")))?;

    Ok(Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
        http2_enabled: h2,
    }))
}

// --- Breakpoint commands ---
