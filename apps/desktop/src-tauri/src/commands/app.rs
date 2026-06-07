use super::common::*;
use std::fs::OpenOptions;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    pub version: String,
    pub build_number: String,
    pub version_identifier: String,
    pub commit_hash: String,
}

pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn app_build_number() -> &'static str {
    option_env!("AIPROXY_BUILD_NUMBER").unwrap_or("0")
}

pub fn app_version_identifier() -> String {
    format!("{}+{}", app_version(), app_build_number())
}

pub fn app_commit_hash() -> &'static str {
    option_env!("AIPROXY_GIT_HASH").unwrap_or("unknown")
}

#[tauri::command]
pub fn get_app_build_info() -> AppBuildInfo {
    AppBuildInfo {
        version: app_version().to_string(),
        build_number: app_build_number().to_string(),
        version_identifier: app_version_identifier(),
        commit_hash: app_commit_hash().to_string(),
    }
}

#[tauri::command]
pub fn show_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let log_file_path = crate::dev_logger::current_log_file_path();

    tracing::info!(
        component = "desktop.app",
        event = "show_log_file_requested",
        log_file = %log_file_path.display(),
        "show_log_file_requested"
    );

    if let Some(parent) = log_file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create log directory {}: {error}", parent.display()))?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .map_err(|error| format!("prepare log file {}: {error}", log_file_path.display()))?;

    app.opener()
        .reveal_item_in_dir(&log_file_path)
        .map_err(|error| format!("show log file {}: {error}", log_file_path.display()))?;

    tracing::info!(
        component = "desktop.app",
        event = "show_log_file_succeeded",
        log_file = %log_file_path.display(),
        "show_log_file_succeeded"
    );

    Ok(log_file_path.display().to_string())
}
