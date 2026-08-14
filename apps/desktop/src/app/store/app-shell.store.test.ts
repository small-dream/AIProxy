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

  it("toggles isChecking and isUpdateDialogOpen", () => {
    useAppShellStore.getState().setUpdateChecking(true);
    expect(useAppShellStore.getState().isChecking).toBe(true);
    useAppShellStore.getState().setUpdateDialogOpen(true);
    expect(useAppShellStore.getState().isUpdateDialogOpen).toBe(true);
  });
});
