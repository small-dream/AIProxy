//! `set_menu_locale` command — thin Tauri surface over `crate::menu::apply_locale`.
//!
//! The command is infallible by design: it returns unit, so the frontend `invoke`
//! never rejects. All failures are logged best-effort inside `apply_locale`.

use tauri::{AppHandle, Runtime};

/// Push the current display-language preference to the native (macOS) menu so it
/// rebuilds in the right language. `preference` is the 3-state LanguagePreference
/// (`"en" | "system" | "zh-CN"`); Rust resolves `system` via sys-locale.
#[tauri::command]
pub fn set_menu_locale<R: Runtime>(app: AppHandle<R>, preference: String) {
    crate::menu::apply_locale(&app, &preference);
}
