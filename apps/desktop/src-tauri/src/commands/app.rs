use super::common::*;
use std::fs::OpenOptions;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    pub version: String,
    pub build_number: String,
    pub version_identifier: String,
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

#[cfg(target_os = "macos")]
pub fn app_about_version() -> String {
    format!("{} (Build {})", app_version(), app_build_number())
}

#[tauri::command]
pub fn get_app_build_info() -> AppBuildInfo {
    AppBuildInfo {
        version: app_version().to_string(),
        build_number: app_build_number().to_string(),
        version_identifier: app_version_identifier(),
    }
}

#[tauri::command]
pub fn show_log_file(app: tauri::AppHandle) -> Result<String, String> {
    let log_file_path = crate::dev_logger::current_log_file_path();

    log_info(
        "desktop.app",
        "show_log_file_requested",
        &[("log_file", log_file_path.display().to_string())],
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

    log_info(
        "desktop.app",
        "show_log_file_succeeded",
        &[("log_file", log_file_path.display().to_string())],
    );

    Ok(log_file_path.display().to_string())
}
