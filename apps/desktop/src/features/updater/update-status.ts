import { coerceAppError } from "@aiproxy/shared-types";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { checkForAppUpdate, installPendingAppUpdate } from "@/services/updater/app-updater";

/**
 * Check for an update and write the result into the shell store. Silent on
 * failure: a network/registry error just leaves availableUpdate null and logs.
 * Returns true when the check completed (update found or not), false when it
 * failed. Never rethrows — startup callers rely on silent failure.
 */
export async function checkForUpdateAndStore(): Promise<boolean> {
  const store = useAppShellStore.getState();
  store.setUpdateChecking(true);
  let ok = false;
  try {
    const info = await checkForAppUpdate();
    store.setAvailableUpdate(info);
    ok = true;
  } catch (error) {
    // Non-fatal: the app works without update info.
    console.warn("[updater] check failed:", coerceAppError(error).message);
    store.setAvailableUpdate(null);
  } finally {
    store.setUpdateChecking(false);
  }
  return ok;
}

/**
 * Install the pending update, streaming progress into the store, then relaunch
 * (relaunch happens inside installPendingAppUpdate).
 */
export async function installUpdateAndStore(): Promise<void> {
  const store = useAppShellStore.getState();
  store.setUpdateInstalling(true);
  store.setUpdateProgress(null);
  try {
    await installPendingAppUpdate((progress) => store.setUpdateProgress(progress));
  } catch (error) {
    console.warn("[updater] install failed:", coerceAppError(error).message);
    store.setUpdateInstalling(false);
    throw error;
  }
}
