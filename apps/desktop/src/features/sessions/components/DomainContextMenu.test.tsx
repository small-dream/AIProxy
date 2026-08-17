import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { DomainContextMenu } from "./DomainContextMenu";

function renderMenu(overrides: Partial<ComponentProps<typeof DomainContextMenu>> = {}) {
  const props: ComponentProps<typeof DomainContextMenu> = {
    anchorPosition: { left: 20, top: 20 },
    host: "api.example.com",
    isHostFocused: false,
    isHostIgnored: false,
    onClose: vi.fn(),
    onExportHost: vi.fn(),
    onFocusHost: vi.fn(),
    onIgnoreHost: vi.fn(),
    onSaveHostFiles: vi.fn(),
    onStopIgnoringHost: vi.fn(),
    onUnfocusHost: vi.fn(),
    ...overrides,
  };

  render(
    <AppProviders>
      <DomainContextMenu {...props} />
    </AppProviders>,
  );

  return props;
}

describe("DomainContextMenu", () => {
  it("offers exporting the selected host", () => {
    const { onExportHost } = renderMenu();

    fireEvent.click(screen.getByText("Export Host"));

    expect(onExportHost).toHaveBeenCalledWith("api.example.com");
  });

  it("offers saving every captured file under the host", () => {
    const { onSaveHostFiles, onClose } = renderMenu();

    fireEvent.click(screen.getByText("Save All Files..."));

    expect(onSaveHostFiles).toHaveBeenCalledWith("api.example.com");
    expect(onClose).toHaveBeenCalled();
  });
});
