import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { UpdateDialog } from "@/features/updater/UpdateDialog";

vi.mock("@/features/updater/update-status", () => ({
  installUpdateAndStore: vi.fn(),
}));

import { installUpdateAndStore } from "@/features/updater/update-status";

const BILINGUAL_BODY = `# AIProxy 9.9.9

## 更新内容

- 修复了一个中文问题。

## What's new

- Fix an English issue.

## Install and update

- English install notes.
`;

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
    useAppPreferencesStore.setState({ languagePreference: "system" });
  });

  it("shows version + rendered English changelog + Update now when an update is available", () => {
    useAppShellStore.setState({
      availableUpdate: {
        version: "9.9.9",
        currentVersion: "0.1.6",
        body: BILINGUAL_BODY,
      },
      isUpdateDialogOpen: true,
    });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    expect(screen.getByText("Fix an English issue.")).toBeInTheDocument();
    expect(screen.queryByText(/中文问题/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/English install notes/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
  });

  it("renders the Chinese changelog when the locale is zh-CN", () => {
    useAppPreferencesStore.setState({ languagePreference: "zh-CN" });
    useAppShellStore.setState({
      availableUpdate: {
        version: "9.9.9",
        currentVersion: "0.1.6",
        body: BILINGUAL_BODY,
      },
      isUpdateDialogOpen: true,
    });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText("修复了一个中文问题。")).toBeInTheDocument();
    expect(screen.queryByText(/Fix an English issue/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Install and update/i)).not.toBeInTheDocument();
  });

  it("shows a friendly fallback when the locale section is missing", () => {
    useAppShellStore.setState({
      availableUpdate: { version: "9.9.9", currentVersion: "0.1.6", body: "- fix something" },
      isUpdateDialogOpen: true,
    });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(
      screen.getByText("No release notes are available for this version."),
    ).toBeInTheDocument();
    expect(screen.queryByText("- fix something")).not.toBeInTheDocument();
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
