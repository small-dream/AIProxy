mod bootstrap;
mod commands;
mod dev_logger;
mod system_proxy;

use bootstrap::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = dev_logger::initialize() {
        eprintln!("level=ERROR component=desktop.app event=logger_init_failed error=\"{error}\"");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_status,
            commands::list_sessions,
            commands::start_proxy,
            commands::stop_proxy,
            commands::enable_system_proxy,
            commands::disable_system_proxy
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Pharles desktop application");
}

fn main() {
    run();
}
