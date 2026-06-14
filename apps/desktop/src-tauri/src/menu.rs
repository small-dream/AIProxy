use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Runtime};

#[cfg(target_os = "macos")]
use crate::commands::{app_build_number, app_commit_hash};

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
    pub const SETUP_WIZARD: &str = "setup_wizard";
}

/// Resolve a LanguagePreference to a concrete menu locale ("en" | "zh-CN").
///
/// `system_locale` is injected by the caller (production: `sys_locale::get_locale`;
/// tests: a fixed value) so this stays a pure, parallel-safe function and never
/// reads global state.
pub fn resolve_menu_locale(preference: &str, system_locale: Option<&str>) -> &'static str {
    match preference {
        "zh-CN" => "zh-CN",
        "en" => "en",
        _ => resolve_system_locale(system_locale),
    }
}

fn resolve_system_locale(system_locale: Option<&str>) -> &'static str {
    match system_locale {
        Some(value) if value.to_lowercase().starts_with("zh") => "zh-CN",
        _ => "en",
    }
}

const MENU_LOCALE_FILE_NAME: &str = "menu-locale.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedMenuLocale {
    preference: String,
}

/// Pure, path-injected writer — testable with a temp dir, never touches the real
/// user data directory.
pub(crate) fn save_menu_locale_to(path: &Path, preference: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create menu locale directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let payload = PersistedMenuLocale {
        preference: preference.to_string(),
    };
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("failed to serialize menu locale: {error}"))?;

    std::fs::write(path, json)
        .map_err(|error| format!("failed to write menu locale file {}: {error}", path.display()))
}

/// Pure, path-injected reader. Returns `None` for missing file or parse failure
/// (parse failures are logged at warn level).
pub(crate) fn load_menu_locale_from(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;

    match serde_json::from_str::<PersistedMenuLocale>(&contents) {
        Ok(state) => Some(state.preference),
        Err(error) => {
            tracing::warn!(
                component = "desktop.menu",
                event = "menu_locale_parse_failed",
                path = %path.display(),
                error = %error,
                "menu_locale_parse_failed"
            );
            None
        }
    }
}

/// Production writer — resolves the real app data dir, then delegates.
pub(crate) fn save_menu_locale(preference: &str) -> Result<(), String> {
    save_menu_locale_to(&resolve_menu_locale_path(), preference)
}

/// Production reader — resolves the real app data dir, then delegates.
pub(crate) fn load_menu_locale() -> Option<String> {
    load_menu_locale_from(&resolve_menu_locale_path())
}

/// Same resolution + fallback chain as `window_state::resolve_window_state_path`:
/// prefer the shared DB dir, then OS data dirs, then temp.
fn resolve_menu_locale_path() -> PathBuf {
    aiproxy_db::connection::resolve_db_dir()
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(std::env::temp_dir)
        })
        .join(MENU_LOCALE_FILE_NAME)
}

/// Apply a language preference end-to-end: persist it, set the global i18n locale,
/// and rebuild the native menu (macOS only).
///
/// Best-effort and infallible: persistence or rebuild failures are logged at warn
/// level but never propagated — the menu is a non-critical surface and a stale
/// language self-heals on the next switch or restart.
pub fn apply_locale<R: Runtime>(app: &AppHandle<R>, preference: &str) {
    let locale = resolve_menu_locale(preference, sys_locale::get_locale().as_deref());

    if let Err(error) = save_menu_locale(preference) {
        tracing::warn!(
            component = "desktop.menu",
            event = "menu_locale_persist_failed",
            error = %error,
            "menu_locale_persist_failed"
        );
    }

    rust_i18n::set_locale(locale);

    #[cfg(target_os = "macos")]
    if let Err(error) = build_menu(app) {
        tracing::warn!(
            component = "desktop.menu",
            event = "menu_rebuild_failed",
            locale = locale,
            error = %error,
            "menu_rebuild_failed"
        );
    }
    // Non-macOS: only persist + set_locale; no native menu to rebuild.
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
    let file_menu = SubmenuBuilder::new(handle, t!("menu.submenu.file"))
        .item(
            &MenuItemBuilder::new(t!("menu.import_har"))
                .id(ids::IMPORT_HAR)
                .accelerator("CmdOrCtrl+Shift+O")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.export_har"))
                .id(ids::EXPORT_HAR)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.clear_all_sessions"))
                .id(ids::CLEAR_ALL_SESSIONS)
                .accelerator("CmdOrCtrl+Shift+Delete")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::close_window(
            handle,
            Some(t!("menu.close_window").as_ref()),
        )?)
        .build()?;

    // --- Edit ---
    let edit_menu = SubmenuBuilder::new(handle, t!("menu.submenu.edit"))
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.find"))
                .id(ids::FIND)
                .accelerator("CmdOrCtrl+F")
                .build(handle)?,
        )
        .build()?;

    // --- View ---
    let view_menu = SubmenuBuilder::new(handle, t!("menu.submenu.view"))
        .item(
            &MenuItemBuilder::new(t!("menu.refresh"))
                .id(ids::REFRESH)
                .accelerator("CmdOrCtrl+R")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.goto.sessions"))
                .id(ids::GOTO_SESSIONS)
                .accelerator("CmdOrCtrl+1")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.goto.compose"))
                .id(ids::GOTO_COMPOSE)
                .accelerator("CmdOrCtrl+2")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.goto.rules"))
                .id(ids::GOTO_RULES)
                .accelerator("CmdOrCtrl+3")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.goto.throttling"))
                .id(ids::GOTO_THROTTLING)
                .accelerator("CmdOrCtrl+4")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.goto.certificates"))
                .id(ids::GOTO_CERTIFICATES)
                .accelerator("CmdOrCtrl+5")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.goto.settings"))
                .id(ids::GOTO_SETTINGS)
                .accelerator("CmdOrCtrl+6")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.zoom.in"))
                .id(ids::ZOOM_IN)
                .accelerator("CmdOrCtrl+Plus")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.zoom.out"))
                .id(ids::ZOOM_OUT)
                .accelerator("CmdOrCtrl+Minus")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.zoom.reset"))
                .id(ids::ZOOM_RESET)
                .accelerator("CmdOrCtrl+0")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.theme.dark"))
                .id(ids::THEME_DARK)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.theme.light"))
                .id(ids::THEME_LIGHT)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.theme.system"))
                .id(ids::THEME_SYSTEM)
                .build(handle)?,
        )
        .build()?;

    // --- Proxy ---
    let proxy_menu = SubmenuBuilder::new(handle, t!("menu.submenu.proxy"))
        .item(
            &MenuItemBuilder::new(t!("menu.start_proxy"))
                .id(ids::START_PROXY)
                .accelerator("CmdOrCtrl+Shift+R")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.stop_proxy"))
                .id(ids::STOP_PROXY)
                .accelerator("CmdOrCtrl+Shift+S")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.toggle_system_proxy"))
                .id(ids::TOGGLE_SYSTEM_PROXY)
                .accelerator("CmdOrCtrl+Shift+P")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.clear_sessions"))
                .id(ids::CLEAR_SESSIONS)
                .build(handle)?,
        )
        .build()?;

    // --- Tools ---
    let android_quick_actions_menu =
        SubmenuBuilder::new(handle, t!("menu.submenu.android_quick_actions"))
            .item(
                &MenuItemBuilder::new(t!("menu.adb_set_proxy"))
                    .id(ids::ADB_SET_PROXY)
                    .build(handle)?,
            )
            .item(
                &MenuItemBuilder::new(t!("menu.adb_clear_proxy"))
                    .id(ids::ADB_CLEAR_PROXY)
                    .build(handle)?,
            )
            .build()?;

    let tools_menu = SubmenuBuilder::new(handle, t!("menu.submenu.tools"))
        .item(
            &MenuItemBuilder::new(t!("menu.breakpoint_rules"))
                .id(ids::BREAKPOINT_RULES)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.throttling"))
                .id(ids::THROTTLING)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.install_cert"))
                .id(ids::INSTALL_CERT)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.cert_status"))
                .id(ids::CERT_STATUS)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.ios_quick_actions"))
                .id(ids::IOS_QUICK_ACTIONS)
                .build(handle)?,
        )
        .item(&android_quick_actions_menu)
        .build()?;

    // --- Window ---
    let window_menu = SubmenuBuilder::new(handle, t!("menu.submenu.window"))
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(handle, None)?)
        .build()?;

    // --- Help ---
    let help_menu = SubmenuBuilder::new(handle, t!("menu.submenu.help"))
        .item(
            &MenuItemBuilder::new(t!("menu.setup_wizard"))
                .id(ids::SETUP_WIZARD)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.check_for_updates"))
                .id(ids::CHECK_FOR_UPDATES)
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.documentation"))
                .id(ids::DOCUMENTATION)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.show_logs"))
                .id(ids::SHOW_LOGS)
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::new(t!("menu.shortcuts"))
                .id(ids::SHORTCUTS)
                .build(handle)?,
        )
        .build()?;

    let app_menu = SubmenuBuilder::new(handle, t!("menu.submenu.app"))
        .item(&PredefinedMenuItem::about(
            handle,
            Some(t!("menu.about").as_ref()),
            Some(about_metadata),
        )?)
        .separator()
        .item(
            &MenuItemBuilder::new(t!("menu.preferences"))
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
        version: None,
        comments: Some(format!(
            "Build {} · {}",
            app_build_number(),
            app_commit_hash()
        )),
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

#[cfg(test)]
mod tests {
    // Every menu key must resolve to a real translation (not the raw key) in both
    // supported locales. Uses the explicit `locale =` form so we never touch the
    // global locale — safe under parallel test execution.
    // MUST mirror every `t!("menu.*")` key used in build_menu — keys used in the
    // menu but absent here won't be covered by the integrity test below.
    const MENU_KEYS: &[&str] = &[
        "menu.submenu.file",
        "menu.submenu.edit",
        "menu.submenu.view",
        "menu.submenu.proxy",
        "menu.submenu.tools",
        "menu.submenu.window",
        "menu.submenu.help",
        "menu.submenu.app",
        "menu.submenu.android_quick_actions",
        "menu.import_har",
        "menu.export_har",
        "menu.clear_all_sessions",
        "menu.close_window",
        "menu.find",
        "menu.refresh",
        "menu.goto.sessions",
        "menu.goto.compose",
        "menu.goto.rules",
        "menu.goto.throttling",
        "menu.goto.certificates",
        "menu.goto.settings",
        "menu.zoom.in",
        "menu.zoom.out",
        "menu.zoom.reset",
        "menu.theme.dark",
        "menu.theme.light",
        "menu.theme.system",
        "menu.start_proxy",
        "menu.stop_proxy",
        "menu.toggle_system_proxy",
        "menu.clear_sessions",
        "menu.breakpoint_rules",
        "menu.throttling",
        "menu.install_cert",
        "menu.cert_status",
        "menu.ios_quick_actions",
        "menu.adb_set_proxy",
        "menu.adb_clear_proxy",
        "menu.setup_wizard",
        "menu.check_for_updates",
        "menu.documentation",
        "menu.show_logs",
        "menu.shortcuts",
        "menu.about",
        "menu.preferences",
    ];

    #[test]
    fn menu_keys_resolve_in_all_locales() {
        // Direct backend lookup (no fallback chain) so a key missing from EITHER
        // locale is detected. `t!` would silently fall back to EN (fallback = "en"),
        // masking a missing ZH-CN translation — so we must not use it here.
        for &key in MENU_KEYS {
            for locale in ["en", "zh-CN"] {
                let value = crate::_RUST_I18N_BACKEND.translate(locale, key);
                assert!(
                    value.is_some(),
                    "missing translation for key `{key}` in locale `{locale}`"
                );
                assert!(
                    !value.unwrap().is_empty(),
                    "empty translation for key `{key}` in locale `{locale}`"
                );
            }
        }
    }

    #[test]
    fn resolve_menu_locale_handles_known_preferences() {
        assert_eq!(super::resolve_menu_locale("zh-CN", None), "zh-CN");
        assert_eq!(super::resolve_menu_locale("en", None), "en");
    }

    #[test]
    fn resolve_menu_locale_system_follows_injected_system_locale() {
        // system preference resolves via the injected system locale
        assert_eq!(super::resolve_menu_locale("system", Some("zh-CN")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("system", Some("zh-TW")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("system", Some("en-US")), "en");
        assert_eq!(super::resolve_menu_locale("system", None), "en");
        // to_lowercase() case-folding: mixed-case input still matches
        assert_eq!(super::resolve_menu_locale("system", Some("ZH-CN")), "zh-CN");
    }

    #[test]
    fn resolve_menu_locale_unknown_preference_falls_back_to_system() {
        assert_eq!(super::resolve_menu_locale("garbage", Some("zh-CN")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("", Some("en-US")), "en");
    }

    #[test]
    fn persisted_menu_locale_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("menu-locale.json");

        super::save_menu_locale_to(&path, "system").expect("save");

        let loaded = super::load_menu_locale_from(&path);
        assert_eq!(loaded.as_deref(), Some("system"));

        // overwrite works
        super::save_menu_locale_to(&path, "zh-CN").expect("save overwrite");
        assert_eq!(super::load_menu_locale_from(&path).as_deref(), Some("zh-CN"));
    }

    #[test]
    fn load_menu_locale_missing_file_returns_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("does-not-exist.json");
        assert_eq!(super::load_menu_locale_from(&path), None);
    }

    #[test]
    fn load_menu_locale_corrupt_file_returns_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("menu-locale.json");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(super::load_menu_locale_from(&path), None);
    }
}
