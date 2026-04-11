mod bootstrap;
mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::get_bootstrap_status])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window should exist");
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Pharles desktop application");
}

fn main() {
    run();
}

