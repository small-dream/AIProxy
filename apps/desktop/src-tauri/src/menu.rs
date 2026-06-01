#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Runtime};

#[cfg(target_os = "macos")]
use crate::commands::{app_about_version, app_build_number};

/// Menu item identifiers used for event matching.
#[cfg(target_os = "macos")]
pub mod ids {
    pub const PREFERENCES: &str = "preferences";
    pub const IMPORT_HAR: &str = "import_har";
    pub const EXPORT_HAR: &str = "export_har";
    pub const CLEAR_ALL_SESSIONS: &str = "clear_all_sessions";
    pub const FIND: &str = "find";
    pub const REFRESH: &str = "refresh";
    pub const GOTO_SESSIONS: &str = "goto_sessions";
    pub const GOTO_COMPOSE: &str = "goto_compose";
    pub const GOTO_RULES: &str = "goto_rules";
    pub const GOTO_THROTTLING: &str = "goto_throttling";
    pub const GOTO_CERTIFICATES: &str = "goto_certificates";
    pub const GOTO_SETTINGS: &str = "goto_settings";
    pub const ZOOM_IN: &str = "zoom_in";
    pub const ZOOM_OUT: &str = "zoom_out";
    pub const ZOOM_RESET: &str = "zoom_reset";
    pub const THEME_DARK: &str = "theme_dark";
    pub const THEME_LIGHT: &str = "theme_light";
    pub const THEME_SYSTEM: &str = "theme_system";
    pub const START_PROXY: &str = "start_proxy";
    pub const STOP_PROXY: &str = "stop_proxy";
    pub const TOGGLE_SYSTEM_PROXY: &str = "toggle_system_proxy";
    pub const CLEAR_SESSIONS: &str = "clear_sessions";
    pub const BREAKPOINT_RULES: &str = "breakpoint_rules";
    pub const THROTTLING: &str = "throttling_tool";
    pub const INSTALL_CERT: &str = "install_cert";
    pub const CERT_STATUS: &str = "cert_status";
    pub const IOS_QUICK_ACTIONS: &str = "ios_quick_actions";
    pub const ADB_SET_PROXY: &str = "adb_set_proxy";
    pub const ADB_CLEAR_PROXY: &str = "adb_clear_proxy";
    pub const CHECK_FOR_UPDATES: &str = "check_for_updates";
    pub const SHOW_LOGS: &str = "show_logs";
    pub const DOCUMENTATION: &str = "documentation";
    pub const SHORTCUTS: &str = "shortcuts";
}

/// Builds and installs the application menu.
///
/// On macOS this becomes the global app menu bar with the app-specific
/// submenu (About, Hide, Services, Quit) as the first item.
/// On Windows/Linux this becomes the window menu bar.
#[cfg(not(target_os = "macos"))]
pub fn build_menu<R: Runtime>(_app: &AppHandle<R>) -> Result<(), tauri::Error> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri::Error> {
    let handle = app;
    let about_metadata = build_about_metadata();

    // --- File ---
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(
            &MenuItemBuilder::new("Import HAR...")
                .id(ids::IMPORT_HAR)
                .accelerator("CmdOrCtrl+Shift+O")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Export as HAR...")
                .id(ids::EXPORT_HAR)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Clear All Sessions")
                .id(ids::CLEAR_ALL_SESSIONS)
                .accelerator("CmdOrCtrl+Shift+Delete")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::close_window(
            handle,
            Some("Close Window"),
        )?)
        .build()?;

    // --- Edit ---
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .separator()
        .item(
            &MenuItemBuilder::new("Find...")
                .id(ids::FIND)
                .accelerator("CmdOrCtrl+F")
                .build(handle)?,
        )
        .build()?;

    // --- View ---
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(
            &MenuItemBuilder::new("Refresh")
                .id(ids::REFRESH)
                .accelerator("CmdOrCtrl+R")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Sessions")
                .id(ids::GOTO_SESSIONS)
                .accelerator("CmdOrCtrl+1")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Compose")
                .id(ids::GOTO_COMPOSE)
                .accelerator("CmdOrCtrl+2")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Rules")
                .id(ids::GOTO_RULES)
                .accelerator("CmdOrCtrl+3")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Throttling")
                .id(ids::GOTO_THROTTLING)
                .accelerator("CmdOrCtrl+4")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Certificates")
                .id(ids::GOTO_CERTIFICATES)
                .accelerator("CmdOrCtrl+5")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Settings")
                .id(ids::GOTO_SETTINGS)
                .accelerator("CmdOrCtrl+6")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Zoom In")
                .id(ids::ZOOM_IN)
                .accelerator("CmdOrCtrl+Plus")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Zoom Out")
                .id(ids::ZOOM_OUT)
                .accelerator("CmdOrCtrl+Minus")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Reset Zoom")
                .id(ids::ZOOM_RESET)
                .accelerator("CmdOrCtrl+0")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Dark Theme")
                .id(ids::THEME_DARK)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Light Theme")
                .id(ids::THEME_LIGHT)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Follow System Theme")
                .id(ids::THEME_SYSTEM)
                .build(handle)?,
        )
        .build()?;

    // --- Proxy ---
    let proxy_menu = SubmenuBuilder::new(handle, "Proxy")
        .item(
            &MenuItemBuilder::new("Start Proxy")
                .id(ids::START_PROXY)
                .accelerator("CmdOrCtrl+Shift+R")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Stop Proxy")
                .id(ids::STOP_PROXY)
                .accelerator("CmdOrCtrl+Shift+S")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Toggle System Proxy")
                .id(ids::TOGGLE_SYSTEM_PROXY)
                .accelerator("CmdOrCtrl+Shift+P")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Clear Sessions")
                .id(ids::CLEAR_SESSIONS)
                .build(handle)?,
        )
        .build()?;

    // --- Tools ---
    let android_quick_actions_menu = SubmenuBuilder::new(handle, "Android Quick Actions")
        .item(
            &MenuItemBuilder::new("Set Proxy via ADB")
                .id(ids::ADB_SET_PROXY)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Clear Proxy via ADB")
                .id(ids::ADB_CLEAR_PROXY)
                .build(handle)?,
        )
        .build()?;

    let tools_menu = SubmenuBuilder::new(handle, "Tools")
        .item(
            &MenuItemBuilder::new("Breakpoint Rules...")
                .id(ids::BREAKPOINT_RULES)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Throttling...")
                .id(ids::THROTTLING)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Install Root Certificate")
                .id(ids::INSTALL_CERT)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Certificate Status")
                .id(ids::CERT_STATUS)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("iOS Quick Actions")
                .id(ids::IOS_QUICK_ACTIONS)
                .build(handle)?,
        )
        .item(&android_quick_actions_menu)
        .build()?;

    // --- Window ---
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(handle, None)?)
        .build()?;

    // --- Help ---
    let help_menu = SubmenuBuilder::new(handle, "Help")
        .item(
            &MenuItemBuilder::new("Check for Updates...")
                .id(ids::CHECK_FOR_UPDATES)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("AIProxy Documentation")
                .id(ids::DOCUMENTATION)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Show Logs")
                .id(ids::SHOW_LOGS)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new("Keyboard Shortcuts")
                .id(ids::SHORTCUTS)
                .build(handle)?,
        )
        .build()?;

    let app_menu = SubmenuBuilder::new(handle, "AIProxy")
        .item(&PredefinedMenuItem::about(
            handle,
            Some("About AIProxy"),
            Some(about_metadata),
        )?)
        .separator()
        .item(
            &MenuItemBuilder::new("Preferences...")
                .id(ids::PREFERENCES)
                .accelerator("CmdOrCtrl+Comma")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(handle, None)?)
        .item(&PredefinedMenuItem::hide_others(handle, None)?)
        .item(&PredefinedMenuItem::show_all(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, None)?)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&proxy_menu)
        .item(&tools_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn build_about_metadata<'a>() -> AboutMetadata<'a> {
    AboutMetadata {
        name: Some("AIProxy".to_string()),
        version: Some(app_about_version()),
        comments: Some(format!("Build number: {}", app_build_number())),
        ..AboutMetadata::default()
    }
}

/// Registers the global menu event handler that forwards all menu actions
/// to the frontend as Tauri events.
pub fn register_menu_event_handler<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(move |app_handle, event| {
        let id: &str = event.id().0.as_ref();
        let payload = serde_json::json!({ "menuId": id });

        // Emit to frontend so React can react to menu actions
        let _ = app_handle.emit("menu-event", payload);
    });
}
