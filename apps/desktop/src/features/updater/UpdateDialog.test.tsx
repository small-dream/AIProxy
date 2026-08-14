import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { UpdateDialog } from "@/features/updater/UpdateDialog";

vi.mock("@/features/updater/update-status", () => ({
  installUpdateAndStore: vi.fn(),
}));

import { installUpdateAndStore } from "@/features/updater/update-status";

describe("UpdateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      lastCheckFailed: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("shows version + changelog + Update now when an update is available", () => {
    useAppShellStore.setState({
      availableUpdate: {
        version: "9.9.9",
        currentVersion: "0.1.6",
        body: "- fix something",
      },
      isUpdateDialogOpen: true,
    });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    expect(screen.getByText("- fix something")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
  });

  it("shows 'up to date' and no Update button when no update", () => {
    useAppShellStore.setState({ isUpdateDialogOpen: true });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).not.toBeInTheDocument();
  });

  it("renders nothing when dialog is closed", () => {
    useAppShellStore.setState({ isUpdateDialogOpen: false });

    const { container } = render(<UpdateDialog />, { wrapper: AppProviders });
    expect(container).toBeEmptyDOMElement();
  });

  it("invokes install when Update now is clicked", () => {
    useAppShellStore.setState({
      availableUpdate: { version: "9.9.9", currentVersion: "0.1.6" },
      isUpdateDialogOpen: true,
    });
    render(<UpdateDialog />, { wrapper: AppProviders });
    fireEvent.click(screen.getByRole("button", { name: /update now/i }));
    expect(installUpdateAndStore).toHaveBeenCalledTimes(1);
  });
});
