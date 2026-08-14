import { beforeEach, describe, expect, it } from "vitest";

import { useAppShellStore } from "@/app/store/app-shell.store";

describe("useAppShellStore update slice", () => {
  beforeEach(() => {
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("sets and clears availableUpdate", () => {
    const { setAvailableUpdate } = useAppShellStore.getState();
    setAvailableUpdate({ version: "9.9.9", currentVersion: "0.1.6" });
    expect(useAppShellStore.getState().availableUpdate?.version).toBe("9.9.9");
    setAvailableUpdate(null);
    expect(useAppShellStore.getState().availableUpdate).toBeNull();
  });

  it("toggles isChecking and isUpdateDialogOpen in both directions", () => {
    useAppShellStore.getState().setUpdateChecking(true);
    expect(useAppShellStore.getState().isChecking).toBe(true);
    useAppShellStore.getState().setUpdateChecking(false);
    expect(useAppShellStore.getState().isChecking).toBe(false);
    useAppShellStore.getState().setUpdateDialogOpen(true);
    expect(useAppShellStore.getState().isUpdateDialogOpen).toBe(true);
    useAppShellStore.getState().setUpdateDialogOpen(false);
    expect(useAppShellStore.getState().isUpdateDialogOpen).toBe(false);
  });

  it("toggles isInstalling in both directions", () => {
    useAppShellStore.getState().setUpdateInstalling(true);
    expect(useAppShellStore.getState().isInstalling).toBe(true);
    useAppShellStore.getState().setUpdateInstalling(false);
    expect(useAppShellStore.getState().isInstalling).toBe(false);
  });

  it("sets and clears updateProgress", () => {
    useAppShellStore.getState().setUpdateProgress({ downloaded: 100, contentLength: 200 });
    expect(useAppShellStore.getState().updateProgress?.downloaded).toBe(100);
    expect(useAppShellStore.getState().updateProgress?.contentLength).toBe(200);
    useAppShellStore.getState().setUpdateProgress(null);
    expect(useAppShellStore.getState().updateProgress).toBeNull();
  });
});
