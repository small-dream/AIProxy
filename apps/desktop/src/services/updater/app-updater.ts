import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { isTauriRuntime } from "@/services/commands/runtime";

type PendingUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

let pendingUpdate: PendingUpdate | null = null;

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

  const update = await check({ timeout: 30_000 });
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
  if (!pendingUpdate) {
    throw new Error("No pending update is available. Check for updates first.");
  }

  let downloaded = 0;
  let contentLength: number | undefined;

  await pendingUpdate.downloadAndInstall((event) => {
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
}
