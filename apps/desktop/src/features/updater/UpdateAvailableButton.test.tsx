import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppShellStore } from "@/app/store/app-shell.store";

import { UpdateAvailableButton } from "./UpdateAvailableButton";

describe("UpdateAvailableButton", () => {
  beforeEach(() => {
    useAppShellStore.setState({
      availableUpdate: null,
      isInstalling: false,
      isUpdateDialogOpen: false,
    });
  });

  it("stays hidden until an update is available", () => {
    const { container } = render(<UpdateAvailableButton />, { wrapper: AppProviders });
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the update dialog for the discovered version", () => {
    useAppShellStore.setState({
      availableUpdate: { currentVersion: "0.1.19", version: "0.1.20" },
    });

    render(<UpdateAvailableButton />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /^update$/i }));
    expect(useAppShellStore.getState().isUpdateDialogOpen).toBe(true);
  });

  it("hides while installation is in progress", () => {
    useAppShellStore.setState({
      availableUpdate: { currentVersion: "0.1.19", version: "0.1.20" },
      isInstalling: true,
    });

    const { container } = render(<UpdateAvailableButton />, { wrapper: AppProviders });
    expect(container).toBeEmptyDOMElement();
  });
});
