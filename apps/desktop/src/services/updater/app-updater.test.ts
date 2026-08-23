import { beforeEach, describe, expect, it, vi } from "vitest";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { checkForAppUpdate, installPendingAppUpdate } from "./app-updater";

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@/services/commands/runtime", () => ({ isTauriRuntime: () => true }));

type DownloadAndInstall = (onEvent?: (event: never) => void) => Promise<void>;

function makePendingUpdate(downloadAndInstall: DownloadAndInstall) {
  return {
    currentVersion: "0.1.23",
    version: "0.1.24",
    body: "release notes",
    date: undefined,
    downloadAndInstall,
  } as never;
}

/** A controllable downloadAndInstall: resolves when the returned trigger fires. */
function deferredDownload() {
  let resolve!: () => void;
  const fn = vi.fn(
    () =>
      new Promise<void>((res) => {
        resolve = res;
      }),
  ) as unknown as DownloadAndInstall & ReturnType<typeof vi.fn>;
  return { fn, resolve: () => resolve() };
}

// Module-level updater state (pendingUpdate / installInFlight) persists between
// tests in this file; the cases below are ordered to build on that deliberately
// and each documents the state it depends on.
describe("app-updater", () => {
  beforeEach(() => {
    vi.mocked(relaunch).mockReset();
    vi.mocked(check).mockReset();
  });

  // P2 4.3-6: a failed check must drop a previously captured pending update —
  // otherwise a later install targets an object that may be installed or
  // superseded already.
  it("clears the stale pending update when a check fails", async () => {
    const good = deferredDownload();
    vi.mocked(check).mockResolvedValueOnce(makePendingUpdate(good.fn));
    await checkForAppUpdate();

    vi.mocked(check).mockRejectedValueOnce(new Error("registry unreachable"));
    await expect(checkForAppUpdate()).rejects.toThrow("registry unreachable");

    // With no valid snapshot the install must refuse instead of downloading.
    await expect(installPendingAppUpdate()).rejects.toThrow("No pending update");
    expect(good.fn).not.toHaveBeenCalled();
  });

  // P2 4.3-6: settings page and update dialog both funnel into this service;
  // overlapping calls must join one running install instead of starting a
  // second concurrent downloadAndInstall.
  it("joins an in-flight install instead of starting a second download", async () => {
    const download = deferredDownload();
    vi.mocked(check).mockResolvedValue(makePendingUpdate(download.fn));
    await checkForAppUpdate();

    const first = installPendingAppUpdate();
    const second = installPendingAppUpdate();
    await Promise.resolve();
    expect(download.fn).toHaveBeenCalledTimes(1);

    download.resolve();
    await Promise.all([first, second]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  // The single-flight guard must clear once the install settles, otherwise a
  // subsequent install attempt would silently no-op forever.
  it("allows a new install after the previous one completes", async () => {
    const download = deferredDownload();
    vi.mocked(check).mockResolvedValue(makePendingUpdate(download.fn));
    await checkForAppUpdate();

    const first = installPendingAppUpdate();
    download.resolve();
    await first;

    const second = installPendingAppUpdate();
    download.resolve(); // resolves the SECOND download created just above
    await second;
    expect(download.fn).toHaveBeenCalledTimes(2);
  });

  // Review follow-up (P2 4.3-6): the awaited promise must be the guarded
  // handle — awaiting only the raw install leaves installInFlight rejected
  // with no handler when there are no concurrent joiners, surfacing as an
  // unhandled rejection.
  it("propagates an install failure and keeps the guard reusable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("download aborted");
    }) as unknown as DownloadAndInstall;
    vi.mocked(check).mockResolvedValue(makePendingUpdate(failing));
    await checkForAppUpdate();

    await expect(installPendingAppUpdate()).rejects.toThrow("download aborted");

    // The single-flight guard cleared even on the failure path, so the next
    // attempt starts a fresh download instead of joining a dead promise.
    const retry = deferredDownload();
    vi.mocked(check).mockResolvedValue(makePendingUpdate(retry.fn));
    await checkForAppUpdate();
    const next = installPendingAppUpdate();
    retry.resolve();
    await next;
    expect(retry.fn).toHaveBeenCalledTimes(1);
  });
});
