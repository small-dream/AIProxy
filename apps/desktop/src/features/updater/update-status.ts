import { coerceAppError } from "@aiproxy/shared-types";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { logDevError, logDevWarn } from "@/services/logger/dev-logger";
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
    store.setLastCheckFailed(false);
    ok = true;
  } catch (error) {
    // Non-fatal: the app works without update info. Structured log so the
    // failure is diagnosable in the packaged app too (review M-8).
    logDevWarn("ui.updater", "update_check_failed", {
      error: coerceAppError(error).message,
    });
    store.setAvailableUpdate(null);
    store.setLastCheckFailed(true);
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
  store.setInstallError(null);
  try {
    await installPendingAppUpdate((progress) => store.setUpdateProgress(progress));
  } catch (error) {
    const message = coerceAppError(error).message;
    // Structured log AND a store-visible failure state: without the latter
    // the install UI silently snapped back to idle and the user could not
    // tell a failed install from a deferred one (review M-8).
    logDevError("ui.updater", "update_install_failed", { error: message });
    store.setInstallError(message);
    store.setUpdateInstalling(false);
    throw error;
  }
  // P2 4.3-6: the download is done at this point; relaunch normally
  // terminates the process before this line runs, but if it doesn't (failed
  // or deferred relaunch), the shell must not stay stuck in the installing
  // state with a disabled button.
  store.setUpdateInstalling(false);
}
