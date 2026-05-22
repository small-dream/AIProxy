import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { buildSearchMatcher, DEFAULT_SEARCH_OPTIONS, type JsonValue } from "./session-inspector.helpers";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";

function createLargeJsonTree(): JsonValue {
  return Object.fromEntries(
    Array.from({ length: 400 }, (_value, index) => [
      `field${index}`,
      index === 399 ? "needle value" : `value ${index}`,
    ]),
  );
}

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

  it("renders string values without wrapping quotes in the tree view", () => {
    render(
      <AppProviders>
        <SessionInspectorJsonTree
          searchQuery=""
          value={{
            url: "https://example.com/demo",
          }}
        />
      </AppProviders>,
    );

    expect(screen.getByText("https://example.com/demo")).toBeInTheDocument();
    expect(screen.queryByText('"https://example.com/demo"')).not.toBeInTheDocument();
  });

  it("renders compact native-style collection labels", () => {
    render(
      <AppProviders>
        <SessionInspectorJsonTree
          searchQuery=""
          value={{
            items: [{ name: "first" }, { name: "second" }],
          }}
        />
      </AppProviders>,
    );

    expect(screen.getByText("Array [2]")).toBeInTheDocument();
    const expandItemsButton = screen.getByTestId("ChevronRightRoundedIcon").closest("button");
    expect(expandItemsButton).not.toBeNull();
    fireEvent.click(expandItemsButton as HTMLButtonElement);

    expect(screen.getByText("[0]")).toBeInTheDocument();
    expect(screen.getAllByText("Object [1]")).toHaveLength(2);
  });

  it("copies string leaf values without wrapping quotes", async () => {
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
            note: "hello world",
          }}
        />
      </AppProviders>,
    );

    fireEvent.contextMenu(screen.getByText("hello world"), {
      clientX: 80,
      clientY: 120,
    });

    fireEvent.click(await screen.findByText("Copy Node"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("hello world");
    });
  });

  it("keeps large JSON trees virtualized while scrolling to the current off-screen match", async () => {
    const matcher = buildSearchMatcher("needle", DEFAULT_SEARCH_OPTIONS);
    const { container } = render(
      <AppProviders>
        <SessionInspectorJsonTree
          currentMatchIndex={0}
          matcher={matcher}
          searchQuery="needle"
          value={createLargeJsonTree()}
        />
      </AppProviders>,
    );
    const scrollContainer = container.firstChild as HTMLDivElement | null;

    await waitFor(() => {
      expect(container).toHaveTextContent("needle value");
      expect(scrollContainer?.scrollTop ?? 0).toBeGreaterThan(0);
    });

    expect(container).not.toHaveTextContent("value 0");
  });
});
