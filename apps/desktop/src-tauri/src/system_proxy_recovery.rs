use std::{fs, path::PathBuf, sync::Arc};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    bootstrap::AppState,
    dev_logger::{log_error, log_info, log_warn},
    system_proxy::{restore_system_proxy, SystemProxySnapshot},
};

const RECOVERY_FILE_NAME: &str = "pending-system-proxy-snapshot.json";
const RECOVERY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSystemProxySnapshot {
    active_workspace_id: Option<String>,
    captured_at: String,
    platform: String,
    schema_version: u32,
    snapshot: SystemProxySnapshot,
}

pub fn persist_pending_snapshot(
    app: &AppHandle,
    active_workspace_id: Option<String>,
    snapshot: &SystemProxySnapshot,
) -> Result<(), String> {
    let path = recovery_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create recovery directory: {error}"))?;
    }

    let record = PendingSystemProxySnapshot {
        active_workspace_id,
        captured_at: Utc::now().to_rfc3339(),
        platform: current_platform().to_string(),
        schema_version: RECOVERY_SCHEMA_VERSION,
        snapshot: snapshot.clone(),
    };
    let json = serde_json::to_string_pretty(&record)
        .map_err(|error| format!("failed to serialize system proxy recovery snapshot: {error}"))?;

    fs::write(&path, json)
        .map_err(|error| format!("failed to write system proxy recovery snapshot: {error}"))?;

    log_info(
        "desktop.system_proxy_recovery",
        "pending_snapshot_persisted",
        &[("path", path.display().to_string())],
    );

    Ok(())
}

pub fn clear_pending_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = recovery_file_path(app)?;
    match fs::remove_file(&path) {
        Ok(()) => {
            log_info(
                "desktop.system_proxy_recovery",
                "pending_snapshot_cleared",
                &[("path", path.display().to_string())],
            );
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to clear system proxy recovery snapshot: {error}"
        )),
    }
}

pub fn restore_pending_snapshot_on_startup(app: &AppHandle, state: &Arc<AppState>) {
    let path = match recovery_file_path(app) {
        Ok(path) => path,
        Err(error) => {
            log_warn(
                "desktop.system_proxy_recovery",
                "recovery_path_unavailable",
                &[("error", error)],
            );
            return;
        }
    };

    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            let message = format!("failed to read pending system proxy snapshot: {error}");
            state.set_system_proxy_recovery_warning(Some(message.clone()));
            log_error(
                "desktop.system_proxy_recovery",
                "pending_snapshot_read_failed",
                &[("error", message)],
            );
            return;
        }
    };

    let record: PendingSystemProxySnapshot = match serde_json::from_str(&json) {
        Ok(record) => record,
        Err(error) => {
            let message = format!("failed to parse pending system proxy snapshot: {error}");
            state.set_system_proxy_recovery_warning(Some(message.clone()));
            log_error(
                "desktop.system_proxy_recovery",
                "pending_snapshot_parse_failed",
                &[("error", message)],
            );
            return;
        }
    };

    if record.schema_version != RECOVERY_SCHEMA_VERSION || record.platform != current_platform() {
        let message =
            "pending system proxy snapshot is incompatible with this app build".to_string();
        state.set_system_proxy_recovery_warning(Some(message.clone()));
        log_warn(
            "desktop.system_proxy_recovery",
            "pending_snapshot_incompatible",
            &[
                ("platform", record.platform),
                ("schema_version", record.schema_version.to_string()),
            ],
        );
        return;
    }

    match restore_system_proxy(&record.snapshot) {
        Ok(()) => {
            state.set_system_proxy_enabled(false);
            state.set_system_proxy_recovery_warning(None);
            if let Err(error) = clear_pending_snapshot(app) {
                log_warn(
                    "desktop.system_proxy_recovery",
                    "pending_snapshot_clear_failed",
                    &[("error", error)],
                );
            }
            log_info(
                "desktop.system_proxy_recovery",
                "pending_snapshot_restored",
                &[("captured_at", record.captured_at)],
            );
        }
        Err(error) => {
            state.store_system_proxy_snapshot(record.snapshot);
            state.set_system_proxy_enabled(true);
            state.set_system_proxy_recovery_warning(Some(error.clone()));
            log_error(
                "desktop.system_proxy_recovery",
                "pending_snapshot_restore_failed",
                &[("error", error)],
            );
        }
    }
}

fn recovery_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(RECOVERY_FILE_NAME))
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unsupported"
    }
}
