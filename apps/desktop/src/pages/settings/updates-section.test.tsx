import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { UpdatesSection } from "@/pages/settings";
import type { AppUpdateInfo } from "@/services/updater/app-updater";

vi.mock("@/features/updater/update-status", () => ({
  checkForUpdateAndStore: vi.fn(),
  installUpdateAndStore: vi.fn(),
}));

import { checkForUpdateAndStore } from "@/features/updater/update-status";

describe("UpdatesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("shows 'up to date' toast after a manual check finds nothing", async () => {
    vi.mocked(checkForUpdateAndStore).mockResolvedValue();

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText(/is up to date/i)).toBeInTheDocument();
  });

  it("shows available detail after a manual check finds an update", async () => {
    vi.mocked(checkForUpdateAndStore).mockImplementation(async () => {
      useAppShellStore.setState({
        availableUpdate: { version: "9.9.9", currentVersion: "0.1.5" } as AppUpdateInfo,
      });
    });

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() => {
      expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    });
  });
});
