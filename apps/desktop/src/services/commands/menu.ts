import { invoke } from "@tauri-apps/api/core";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export type MenuLanguagePreference = "en" | "system" | "zh-CN";

/**
 * Push the current display-language preference to the native (macOS) menu so it
 * rebuilds in the right language.
 *
 * The Rust command is infallible (returns unit); we also swallow IPC errors here
 * because callers invoke this fire-and-forget from an effect and must never
 * surface an unhandled promise rejection for a non-critical menu sync.
 */
export async function setMenuLocale(preference: MenuLanguagePreference): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_menu_locale_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "set_menu_locale_requested", { preference });
    await invoke("set_menu_locale", { preference });
    logDevDebug("ui.commands", "set_menu_locale_succeeded", { preference });
  } catch (error) {
    reportCommandFailure("set_menu_locale", error);
  }
}
