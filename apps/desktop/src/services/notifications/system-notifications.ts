import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { logDevWarn } from "@/services/logger/dev-logger";
import { isTauriRuntime } from "@/services/commands/runtime";

// Permission is requested lazily at most once per session: firing the OS
// prompt at app start (before the user ever triggers a notification) would be
// intrusive, and re-asking after a denial is noise.
let permissionRequested = false;

/**
 * Best-effort OS notification permission check (requesting once per session).
 * Returns false outside Tauri or when the OS denied the permission — callers
 * must treat that as a silent degrade, never as a user-facing error.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    let granted = await isPermissionGranted();
    if (!granted && !permissionRequested) {
      permissionRequested = true;
      granted = (await requestPermission()) === "granted";
    }
    return granted;
  } catch (error) {
    // e.g. missing notification daemon on some Linux setups — degrade silently.
    logDevWarn("notifications", "permission_check_failed", { error: String(error) });
    return false;
  }
}

/**
 * Fire an OS-level notification. Silent no-op outside Tauri or without
 * permission; failures are logged, never surfaced to the UI (the in-app
 * channel remains the primary feedback path).
 */
export async function sendSystemNotification(title: string, body: string): Promise<void> {
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  try {
    sendNotification({ title, body });
  } catch (error) {
    logDevWarn("notifications", "send_failed", { error: String(error), title });
  }
}
