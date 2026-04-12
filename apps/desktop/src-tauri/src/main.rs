mod bootstrap;
mod commands;
mod dev_logger;
mod system_proxy;

use bootstrap::AppState;
use dev_logger::{log_error, log_info, log_warn};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use system_proxy::restore_system_proxy;
use tauri::{Manager, RunEvent};

static SHUTDOWN_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = dev_logger::initialize() {
        eprintln!("level=ERROR component=desktop.app event=logger_init_failed error=\"{error}\"");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_status,
            commands::list_sessions,
            commands::get_session_detail,
            commands::clear_sessions,
            commands::start_proxy,
            commands::stop_proxy,
            commands::enable_system_proxy,
            commands::disable_system_proxy,
            commands::get_certificate_status,
            commands::generate_root_certificate,
            commands::open_certificate_install_guide,
            commands::launch_certificate_installer,
            commands::get_local_ip,
            commands::send_composed_request
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pharles desktop application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            cleanup_before_exit(app_handle);
        }
    });
}

fn main() {
    run();
}

fn cleanup_before_exit(app_handle: &tauri::AppHandle) {
    if SHUTDOWN_CLEANUP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_state = app_handle.state::<Arc<AppState>>();
    let workspace_id = app_state
        .read_status()
        .active_workspace_id
        .unwrap_or_else(|| "default".to_string());

    log_info(
        "desktop.app",
        "shutdown_cleanup_started",
        &[("workspace_id", workspace_id.clone())],
    );

    if let Some(runtime_handles) = app_state.take_runtime() {
        tauri::async_runtime::block_on(async {
            runtime_handles.proxy_server_handle.shutdown().await;
            let _ = runtime_handles.collector_handle.await;
        });

        let _ = app_state.stop_proxy(workspace_id.clone());
        log_info(
            "desktop.app",
            "shutdown_proxy_runtime_stopped",
            &[("workspace_id", workspace_id.clone())],
        );
    }

    if let Some(snapshot) = app_state.take_system_proxy_snapshot() {
        match restore_system_proxy(&snapshot) {
            Ok(()) => {
                let _ = app_state.set_system_proxy_enabled(false);
                log_info(
                    "desktop.app",
                    "shutdown_system_proxy_restored",
                    &[("workspace_id", workspace_id)],
                );
            }
            Err(error) => {
                app_state.store_system_proxy_snapshot(snapshot);
                log_error(
                    "desktop.app",
                    "shutdown_system_proxy_restore_failed",
                    &[("error", error)],
                );
            }
        }
    } else if app_state.read_status().system_proxy_enabled {
        let _ = app_state.set_system_proxy_enabled(false);
        log_warn(
            "desktop.app",
            "shutdown_system_proxy_snapshot_missing",
            &[(
                "reason",
                "system proxy was enabled but no snapshot remained for restore".to_string(),
            )],
        );
    }
}
