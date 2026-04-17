import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";

describe("SessionInspectorJsonTree", () => {
  it("copies the selected parent node data from the context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    render(
      <AppProviders>
        <SessionInspectorJsonTree
          searchQuery=""
          value={{
            user: {
              age: 30,
              name: "Alice",
            },
          }}
        />
      </AppProviders>,
    );

    fireEvent.contextMenu(screen.getByText("user"), {
      clientX: 80,
      clientY: 120,
    });

    fireEvent.click(await screen.findByText("Copy Node"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{\n    "age": 30,\n    "name": "Alice"\n}');
    });
  });
});
