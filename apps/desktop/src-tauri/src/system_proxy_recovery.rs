use std::{fs, path::PathBuf, sync::Arc};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    bootstrap::AppState,
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

    // L8: write atomically (temp file in the same directory + rename). A plain
    // fs::write truncates-then-writes; if the process is killed mid-write (or
    // the disk fills / power drops) the recovery file is left truncated, so the
    // next launch cannot parse it and the user's system proxy is left pointing
    // at the dead AIProxy port. Atomic write ensures the file is either the
    // previous complete snapshot or the new one — never a torn mix. This is the
    // load-bearing piece of the A8 crash-recovery story (see ADR-004).
    write_atomic(&path, json.as_bytes())
        .map_err(|error| format!("failed to write system proxy recovery snapshot: {error}"))?;

    tracing::info!(
        component = "desktop.system_proxy_recovery",
        event = "pending_snapshot_persisted",
        path = %path.display(),
        "pending_snapshot_persisted"
    );

    Ok(())
}

/// Write `contents` to `path` atomically: write to a temp file in the same
/// directory, then rename over the target. `std::fs::rename` is atomic on POSIX
/// and uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` on Windows, so the
/// destination is never observed in a half-written state. The temp file is
/// cleaned up if the rename fails.
fn write_atomic(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    // Use a unique temp name to avoid collisions between concurrent writers.
    let temp_path = directory.join(format!(
        ".{}-{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recovery"),
        std::process::id(),
    ));
    if let Err(error) = fs::write(&temp_path, contents) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

pub fn clear_pending_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = recovery_file_path(app)?;
    match fs::remove_file(&path) {
        Ok(()) => {
            tracing::info!(
                component = "desktop.system_proxy_recovery",
                event = "pending_snapshot_cleared",
                path = %path.display(),
                "pending_snapshot_cleared"
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
            tracing::warn!(
                component = "desktop.system_proxy_recovery",
                event = "recovery_path_unavailable",
                error = %error,
                "recovery_path_unavailable"
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
            tracing::error!(
                component = "desktop.system_proxy_recovery",
                event = "pending_snapshot_read_failed",
                error = %message,
                "pending_snapshot_read_failed"
            );
            return;
        }
    };

    let record: PendingSystemProxySnapshot = match serde_json::from_str(&json) {
        Ok(record) => record,
        Err(error) => {
            let message = format!("failed to parse pending system proxy snapshot: {error}");
            state.set_system_proxy_recovery_warning(Some(message.clone()));
            tracing::error!(
                component = "desktop.system_proxy_recovery",
                event = "pending_snapshot_parse_failed",
                error = %message,
                "pending_snapshot_parse_failed"
            );
            return;
        }
    };

    if record.schema_version != RECOVERY_SCHEMA_VERSION || record.platform != current_platform() {
        let message =
            "pending system proxy snapshot is incompatible with this app build".to_string();
        state.set_system_proxy_recovery_warning(Some(message.clone()));
        tracing::warn!(
            component = "desktop.system_proxy_recovery",
            event = "pending_snapshot_incompatible",
            platform = %record.platform,
            schema_version = record.schema_version,
            "pending_snapshot_incompatible"
        );
        return;
    }

    match restore_system_proxy(&record.snapshot) {
        Ok(()) => {
            state.set_system_proxy_enabled(false);
            state.set_system_proxy_recovery_warning(None);
            if let Err(error) = clear_pending_snapshot(app) {
                tracing::warn!(
                    component = "desktop.system_proxy_recovery",
                    event = "pending_snapshot_clear_failed",
                    error = %error,
                    "pending_snapshot_clear_failed"
                );
            }
            tracing::info!(
                component = "desktop.system_proxy_recovery",
                event = "pending_snapshot_restored",
                captured_at = %record.captured_at,
                "pending_snapshot_restored"
            );
        }
        Err(error) => {
            state.store_system_proxy_snapshot(record.snapshot);
            state.set_system_proxy_enabled(true);
            state.set_system_proxy_recovery_warning(Some(error.clone()));
            tracing::error!(
                component = "desktop.system_proxy_recovery",
                event = "pending_snapshot_restore_failed",
                error = %error,
                "pending_snapshot_restore_failed"
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
