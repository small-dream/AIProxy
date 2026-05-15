use super::common::*;

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
