import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { UpdatesSection } from "@/pages/settings";
import { checkForAppUpdate, type AppUpdateInfo } from "@/services/updater/app-updater";

vi.mock("@/services/updater/app-updater", () => ({
  checkForAppUpdate: vi.fn(),
  installPendingAppUpdate: vi.fn(),
}));

describe("UpdatesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an 'up to date' toast when no update is available", async () => {
    vi.mocked(checkForAppUpdate).mockResolvedValue(null);

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText(/is up to date/i)).toBeInTheDocument();
  });

  it("shows available update detail and no 'up to date' toast when an update exists", async () => {
    vi.mocked(checkForAppUpdate).mockResolvedValue({
      version: "9.9.9",
      currentVersion: "0.1.5",
    } as AppUpdateInfo);

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() => {
      expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/is up to date/i)).not.toBeInTheDocument();
  });
});
