mod bootstrap;
mod commands;
mod dev_logger;
mod menu;
mod session_stats;
mod system_proxy;
mod window_state;
mod workspace;

use bootstrap::AppState;
use dev_logger::{log_error, log_info, log_warn};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use system_proxy::restore_system_proxy;
use tauri::{Manager, RunEvent};
use window_state::{
    persist_main_window_state,
    register_main_window_state_tracking,
    schedule_main_window_state_restore,
    restore_main_window_state,
};

static SHUTDOWN_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = dev_logger::initialize() {
        eprintln!("level=ERROR component=desktop.app event=logger_init_failed error=\"{error}\"");
    }

    match session_stats::initialize() {
        Ok(Some(path)) => {
            log_info(
                "desktop.app",
                "session_stats_initialized",
                &[("stats_file", path.display().to_string())],
            );
        }
        Ok(None) => {}
        Err(error) => {
            log_warn(
                "desktop.app",
                "session_stats_init_failed",
                &[("error", error)],
            );
        }
    }

    // Initialize database before building the app
    let db_connection = match aiproxy_db::connection::open_database() {
        Ok(conn) => {
            log_info("desktop.app", "database_opened", &[]);
            conn
        }
        Err(error) => {
            log_error("desktop.app", "database_open_failed", &[("error", error.clone())]);
            eprintln!("level=ERROR component=desktop.app event=database_open_failed error=\"{error}\"");
            std::process::exit(1);
        }
    };

    let body_store_dir = aiproxy_db::connection::resolve_db_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("aiproxy"))
        .join("bodies");
    let body_store = aiproxy_db::body_store::BodyStore::new(body_store_dir);
    if let Err(error) = body_store.ensure_dir() {
        log_error("desktop.app", "body_store_init_failed", &[("error", error.clone())]);
    }

    let app_state = AppState::new(
        Arc::new(Mutex::new(db_connection)),
        Arc::new(body_store),
    );

    // Seed default workspace to DB if empty
    {
        let conn = app_state.read_db_connection().lock().expect("db mutex should not be poisoned");
        if aiproxy_db::workspaces::is_empty(&conn) {
            let default_ws = app_state.read_workspace_manager().list();
            if let Some(ws) = default_ws.first() {
                let row = aiproxy_db::workspaces::WorkspaceRow {
                    id: ws.id.clone(),
                    name: ws.name.clone(),
                    proxy_port: ws.proxy_port,
                    ssl_enabled: ws.ssl_enabled,
                    system_proxy_enabled: ws.system_proxy_enabled,
                    storage_path: ws.storage_path.clone(),
                    created_at: ws.created_at.clone(),
                    updated_at: ws.updated_at.clone(),
                };
                if let Err(error) = aiproxy_db::workspaces::upsert_workspace(&conn, &row) {
                    log_error("desktop.app", "seed_default_workspace_failed", &[("error", error)]);
                }
            }
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(app_state))
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_status,
            commands::list_sessions,
            commands::get_session_detail,
            commands::clear_sessions,
            commands::delete_sessions_except,
            commands::set_focused_host,
            commands::start_proxy,
            commands::stop_proxy,
            commands::enable_system_proxy,
            commands::disable_system_proxy,
            commands::get_certificate_status,
            commands::generate_root_certificate,
            commands::open_certificate_install_guide,
            commands::launch_certificate_installer,
            commands::list_android_adb_devices,
            commands::install_android_certificate_via_adb,
            commands::list_ios_simulators,
            commands::install_ios_certificate_via_simulator,
            commands::set_android_proxy_via_adb,
            commands::clear_android_proxy_via_adb,
            commands::get_local_ip,
            commands::send_composed_request,
            commands::list_breakpoint_rules,
            commands::set_breakpoint_rules,
            commands::resolve_breakpoint,
            commands::list_rewrite_rules,
            commands::save_rewrite_rule,
            commands::list_map_rules,
            commands::save_map_rule,
            commands::list_script_rules,
            commands::save_script_rule,
            commands::read_script_source_file,
            commands::delete_rule,
            commands::list_dns_mappings,
            commands::save_dns_mapping,
            commands::list_script_session_trace,
            commands::list_throttle_profiles,
            commands::save_throttle_profile,
            commands::set_active_throttle_profile,
            commands::list_workspaces,
            commands::create_workspace,
            commands::load_workspace,
            commands::update_workspace,
            commands::list_ws_messages,
            commands::get_ws_connection_status,
            commands::inject_ws_message,
            commands::search_ws_messages,
            commands::list_api_collections,
            commands::upsert_api_collection,
            commands::delete_api_collection,
            commands::list_api_collection_items,
            commands::get_api_collection_item,
            commands::upsert_api_collection_item,
            commands::delete_api_collection_item,
            commands::move_api_collection_item,
            commands::save_session_to_collection,
            commands::list_api_environments,
            commands::upsert_api_environment,
            commands::delete_api_environment,
            commands::list_api_environment_variables,
            commands::set_api_environment_variables,
            commands::batch_execute_collection_items
        ])
        .setup(|app| {
            let state = app.state::<Arc<AppState>>();
            state.set_app_handle(app.handle().clone());

            if let Err(error) = menu::build_menu(app.handle()) {
                log_warn("desktop.app", "menu_build_failed", &[("error", error.to_string())]);
            }
            menu::register_menu_event_handler(app.handle());

            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            register_main_window_state_tracking(&window);
            window.show()?;
            restore_main_window_state(&window);
            schedule_main_window_state_restore(&window);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build AIProxy desktop application");

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

    if let Some(window) = app_handle.get_webview_window("main") {
        persist_main_window_state(&window);
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
        app_state.set_runtime(runtime_handles);
        tauri::async_runtime::block_on(async {
            let _ = commands::shutdown_proxy_runtime(Arc::clone(&app_state)).await;
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
