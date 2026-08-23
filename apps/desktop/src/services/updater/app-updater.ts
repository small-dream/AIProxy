import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { isTauriRuntime } from "@/services/commands/runtime";

type PendingUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

let pendingUpdate: PendingUpdate | null = null;

// P2 4.3-6: single-flight guard for downloadAndInstall. Both the settings page
// and the update dialog can trigger an install, and nothing else serializes
// them — two overlapping installs used to download concurrently. Later callers
// join the in-flight promise instead of starting a second download (their own
// progress callback is simply not wired into the running one).
let installInFlight: Promise<void> | null = null;

export type AppUpdateInfo = {
  body?: string;
  currentVersion: string;
  date?: string;
  version: string;
};

export type AppUpdateProgress = {
  contentLength?: number;
  downloaded: number;
};

function createProgress(downloaded: number, contentLength?: number): AppUpdateProgress {
  return {
    downloaded,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  if (!isTauriRuntime()) {
    throw new Error("Updates are available only in the desktop app.");
  }

  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check({ timeout: 30_000 });
  } catch (error) {
    // P2 4.3-6: a failed check must drop any stale pending handle — keeping
    // it would let a later install target an update object that may already
    // be installed or superseded.
    pendingUpdate = null;
    throw error;
  }
  pendingUpdate = update;

  if (!update) return null;

  return {
    currentVersion: update.currentVersion,
    version: update.version,
    ...(update.body === undefined ? {} : { body: update.body }),
    ...(update.date === undefined ? {} : { date: update.date }),
  };
}

export async function installPendingAppUpdate(
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  // P2 4.3-6: never start a second concurrent downloadAndInstall.
  if (installInFlight) {
    return installInFlight;
  }

  if (!pendingUpdate) {
    throw new Error("No pending update is available. Check for updates first.");
  }

  const update = pendingUpdate;
  let downloaded = 0;
  let contentLength: number | undefined;

  const install = (async () => {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          downloaded = 0;
          contentLength = event.data.contentLength ?? undefined;
          onProgress?.(createProgress(downloaded, contentLength));
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress?.(createProgress(downloaded, contentLength));
          break;
        case "Finished":
          onProgress?.(createProgress(contentLength ?? downloaded, contentLength));
          break;
      }
    });

    await relaunch();
  })();

  installInFlight = install.finally(() => {
    installInFlight = null;
  });

  await install;
}
