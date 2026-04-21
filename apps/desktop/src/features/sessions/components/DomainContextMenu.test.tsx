import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { DomainContextMenu } from "./DomainContextMenu";

describe("DomainContextMenu", () => {
  it("offers exporting the selected host", () => {
    const handleExportHost = vi.fn();

    render(
      <AppProviders>
        <DomainContextMenu
          anchorPosition={{ left: 20, top: 20 }}
          host="api.example.com"
          isHostFocused={false}
          isHostIgnored={false}
          onClose={vi.fn()}
          onExportHost={handleExportHost}
          onFocusHost={vi.fn()}
          onIgnoreHost={vi.fn()}
          onStopIgnoringHost={vi.fn()}
          onUnfocusHost={vi.fn()}
        />
      </AppProviders>,
    );

    fireEvent.click(screen.getByText("Export Host"));

    expect(handleExportHost).toHaveBeenCalledWith("api.example.com");
  });
});
