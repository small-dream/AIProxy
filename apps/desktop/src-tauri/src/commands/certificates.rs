use super::common::*;

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

fn get_certificate_status_impl(state: Arc<AppState>) -> Result<CertificateStateSnapshot, String> {
    let platform = detect_platform();

    let storage =
        CertStorage::resolve().map_err(|e| format!("failed to resolve cert storage: {e}"))?;

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
        .map_err(|e| format!("failed to read root cert: {e}"))?;
    let key_pem = storage
        .load_root_key_pem()
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
    let storage =
        CertStorage::resolve().map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    // If already exists and not forcing regeneration, return existing status
    if storage.root_cert_exists() && !input.force_regenerate.unwrap_or(false) {
        return get_certificate_status_impl(state);
    }

    // Generate new root CA
    let root_ca = RootCaPair::generate().map_err(|e| format!("failed to generate root CA: {e}"))?;

    storage
        .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
        .map_err(|e| format!("failed to save root CA: {e}"))?;

    // Create server config for MITM
    let server_config = root_ca
        .create_server_config(&storage)
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
    let storage =
        CertStorage::resolve().map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("No certificate found. Generate one first.".to_string());
    }

    storage
        .ensure_root_cert_install_copy()
        .map_err(|e| format!("failed to prepare installable root cert: {e}"))?;

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let remote_path = "/sdcard/Download/aiproxy-root-ca.cer";

    let adb = resolve_adb_path()?;
    let push_output = std::process::Command::new(&adb)
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
        .output()
        .map_err(adb_spawn_error)?;

    if !launch_output.status.success() {
        return Err(format!(
            "Failed to open Android Security settings: {}",
            format_command_output(&launch_output)
        ));
    }

    let launch_text = format_command_output(&launch_output);
    if launch_text.contains("Error:") {
        return Err(format!(
            "Android reported an error while opening Security settings: {}",
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

fn list_ios_simulators_impl() -> Result<Vec<IosSimulatorDevice>, String> {
    read_ios_simulators()
}

fn install_ios_certificate_via_simulator_impl(
    input: InstallIosCertificateViaSimulatorInput,
    _state: Arc<AppState>,
) -> Result<IosSimulatorInstallResult, String> {
    let storage =
        CertStorage::resolve().map_err(|e| format!("failed to resolve cert storage: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("No certificate found. Generate one first.".to_string());
    }

    let simulator = resolve_ios_simulator(input.simulator_udid.as_deref())?;

    let output = std::process::Command::new("xcrun")
        .args(["simctl", "keychain", &simulator.udid, "add-root-cert"])
        .arg(storage.root_cert_path())
        .output()
        .map_err(xcrun_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to install the root certificate into iOS Simulator `{}`: {}",
            simulator.name,
            format_command_output(&output)
        ));
    }

    log_info(
        "desktop.commands",
        "install_ios_certificate_via_simulator_succeeded",
        &[
            ("simulator_name", simulator.name.clone()),
            ("simulator_udid", simulator.udid.clone()),
        ],
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
        return Err("Android proxy host cannot be empty.".to_string());
    }

    let device_serial = resolve_adb_target_device(input.device_serial.as_deref())?;
    let proxy_address = format!("{host}:{}", input.port);

    run_adb_shell_command(
        &device_serial,
        &["settings", "put", "global", "http_proxy", &proxy_address],
    )?;

    log_info(
        "desktop.commands",
        "set_android_proxy_via_adb_succeeded",
        &[
            ("device_serial", device_serial.clone()),
            ("proxy_address", proxy_address.clone()),
        ],
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

    log_info(
        "desktop.commands",
        "clear_android_proxy_via_adb_succeeded",
        &[("device_serial", device_serial.clone())],
    );

    Ok(AndroidAdbProxyResult {
        success: true,
        device_serial,
        proxy_address: None,
    })
}

fn open_certificate_file(cert_path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["cryptext.dll,CryptExtOpenCER", cert_path])
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
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(cert_path)
            .spawn()
            .map_err(|e| format!("Failed to open certificate file: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = cert_path;
        Err("Certificate launcher is not supported on this platform.".to_string())
    }
}

fn read_adb_devices() -> Result<Vec<AndroidAdbDevice>, String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
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

fn read_ios_simulators() -> Result<Vec<IosSimulatorDevice>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("iOS Simulator quick actions are only supported on macOS.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("xcrun")
            .args(["simctl", "list", "devices", "available", "--json"])
            .output()
            .map_err(xcrun_spawn_error)?;

        if !output.status.success() {
            return Err(format!(
                "Failed to query iOS Simulators: {}",
                format_command_output(&output)
            ));
        }

        let payload: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("failed to parse simulator list: {error}"))?;
        let Some(devices_by_runtime) = payload.get("devices").and_then(|value| value.as_object())
        else {
            return Err("Simulator list did not include a devices map.".to_string());
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

fn resolve_ios_simulator(requested_udid: Option<&str>) -> Result<IosSimulatorDevice, String> {
    let simulators = read_ios_simulators()?;

    if let Some(requested_udid) = requested_udid {
        let Some(simulator) = simulators
            .iter()
            .find(|simulator| simulator.udid == requested_udid)
        else {
            return Err(format!(
                "iOS Simulator `{requested_udid}` was not found in the booted simulator list. Refresh the simulator list and try again."
            ));
        };

        return Ok(simulator.clone());
    }

    if simulators.is_empty() {
        return Err(
            "No booted iOS Simulator was found. Launch a simulator first, then try again."
                .to_string(),
        );
    }

    if simulators.len() > 1 {
        return Err(format!(
            "Multiple booted iOS Simulators were found ({}). Choose one in the Mobile Setup page, then try again.",
            simulators
                .iter()
                .map(|simulator| simulator.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(simulators[0].clone())
}

fn resolve_adb_path() -> Result<std::path::PathBuf, String> {
    // 1. Try bare "adb" from PATH
    if let Ok(output) = std::process::Command::new("adb").arg("--version").output() {
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

    Err("adb was not found. Install Android Platform Tools (https://developer.android.com/tools/releases/platform-tools) and ensure `adb` is on PATH or ANDROID_HOME is set.".to_string())
}

fn adb_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return "adb was not found in PATH. Install Android Platform Tools and make sure the `adb` command is available.".to_string();
    }

    format!("failed to run adb: {error}")
}

fn xcrun_spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return "xcrun was not found in PATH. Install Xcode Command Line Tools and make sure the `xcrun` command is available.".to_string();
    }

    format!("failed to run xcrun: {error}")
}

fn run_adb_shell_command(device_serial: &str, shell_args: &[&str]) -> Result<(), String> {
    let adb = resolve_adb_path()?;
    let output = std::process::Command::new(&adb)
        .args(["-s", device_serial, "shell"])
        .args(shell_args)
        .output()
        .map_err(adb_spawn_error)?;

    if !output.status.success() {
        return Err(format!(
            "Failed to run `adb shell {}` on Android device `{}`: {}",
            shell_args.join(" "),
            device_serial,
            format_command_output(&output)
        ));
    }

    let output_text = format_command_output(&output);
    if output_text.contains("Exception occurred while executing")
        || output_text.starts_with("Error:")
    {
        return Err(format!(
            "Android rejected `adb shell {}` on `{}`: {}",
            shell_args.join(" "),
            device_serial,
            output_text
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
pub(super) fn try_load_tls_manager() -> Result<Arc<TlsManager>, String> {
    let storage = CertStorage::resolve().map_err(|e| format!("cert storage resolve: {e}"))?;

    if !storage.root_cert_exists() {
        return Err("no root certificate found".to_string());
    }

    let cert_pem = storage
        .load_root_cert_pem()
        .map_err(|e| format!("read cert: {e}"))?;
    let key_pem = storage
        .load_root_key_pem()
        .map_err(|e| format!("read key: {e}"))?;

    let root_ca =
        RootCaPair::load_from_pem(&cert_pem, &key_pem).map_err(|e| format!("load root CA: {e}"))?;

    let server_config = root_ca
        .create_server_config(&storage)
        .map_err(|e| format!("create server config: {e}"))?;

    Ok(Arc::new(TlsManager {
        root_ca,
        storage: Arc::new(storage),
        server_config,
    }))
}

// --- Breakpoint commands ---
