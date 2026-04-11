use crate::bootstrap::BootstrapStatus;

#[tauri::command]
pub fn get_bootstrap_status() -> BootstrapStatus {
    BootstrapStatus::default()
}

