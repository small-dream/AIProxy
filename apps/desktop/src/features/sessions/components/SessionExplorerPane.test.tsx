import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@aiproxy/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { buildSessionHostGroups } from "../session-explorer.helpers";
import { SessionExplorerPane } from "./SessionExplorerPane";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 26,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: `virtual-${i}`,
        start: i * 26,
        size: 26,
      })),
  }),
}));

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/users",
    protocol: "HTTP/1.1",
    responseMimeType: "application/json; charset=utf-8",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "http://api.example.com/users",
    ...overrides,
  };
}

// Base props every render in this file shares.
function basePaneProps() {
  return {
    errorMessage: undefined,
    expandedHosts: [] as string[],
    focusedHosts: new Set<string>(),
    ignoredHosts: new Set<string>(),
    isLoading: false,
    multiSelectedSessionIds: new Set<string>(),
    onClearMultiSelection: () => {},
    onDisableThrottledOnly: () => {},
    onDeleteSelected: () => {},
    onExportSelected: () => {},
    onSaveSelectedResponses: () => {},
    onSelectSession: () => {},
    onSearchValueChange: () => {},
    onStopIgnoringHost: () => {},
    onToggleHost: () => {},
    onUnfocusHost: () => {},
    searchValue: "",
    selectedSessionId: undefined,
    showOnlyThrottled: false,
    visibleSessionOrder: [] as string[],
  };
}

describe("SessionExplorerPane", () => {
  it("renders a JSON icon for successful JSON responses", () => {
    const groups = buildSessionHostGroups([createSessionSummary({})], "");

    render(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("json-file-icon")).toBeInTheDocument();
  });

  it("renders a focus icon for focused hosts and a separate icon for the unfocused aggregate", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-1",
          url: "http://api.example.com/users",
        }),
        createSessionSummary({
          host: "cdn.example.com",
          id: "session-2",
          url: "http://cdn.example.com/app.js",
          path: "/app.js",
        }),
      ],
      "",
      {
        focusedHosts: ["api.example.com"],
        unfocusedLabel: "Unfocused",
      },
    );

    render(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          expandedHosts={groups.map((group) => group.key)}
          groups={groups}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("focused-host-icon")).toBeInTheDocument();
    expect(screen.getByTestId("unfocused-group-icon")).toBeInTheDocument();
    expect(screen.getByTestId("aggregate-host-icon")).toBeInTheDocument();
  });

  it("renders the bottom search filter and forwards changes to the full-field search", () => {
    vi.useFakeTimers();
    const handleSearchValueChange = vi.fn();

    render(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          groups={[]}
          onSearchValueChange={handleSearchValueChange}
          searchValue="api"
        />
      </AppProviders>,
    );

    const input = screen.getByPlaceholderText(/Search URL/);
    expect(input).toHaveValue("api");

    fireEvent.change(input, { target: { value: "assets" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(handleSearchValueChange).toHaveBeenCalledWith("assets");
  });

  it("navigates sessions with ArrowDown/ArrowUp in visual tree order", () => {
    const handleSelectSession = vi.fn();
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({ id: "session-1" }),
        createSessionSummary({
          id: "session-2",
          path: "/posts",
          url: "http://api.example.com/posts",
        }),
      ],
      "",
    );

    const { rerender } = render(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
          onSelectSession={handleSelectSession}
          visibleSessionOrder={["session-1", "session-2"]}
        />
      </AppProviders>,
    );

    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(handleSelectSession).toHaveBeenLastCalledWith("session-1");

    // The container applies the selection on the next render (as in the real
    // app); re-render with the updated single selection before the next arrow.
    rerender(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
          onSelectSession={handleSelectSession}
          selectedSessionId="session-1"
          visibleSessionOrder={["session-1", "session-2"]}
        />
      </AppProviders>,
    );

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(handleSelectSession).toHaveBeenLastCalledWith("session-2");

    // Move the selection to the last item, then ArrowUp must go back to the
    // first visual item.
    rerender(
      <AppProviders>
        <SessionExplorerPane
          {...basePaneProps()}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
          onSelectSession={handleSelectSession}
          selectedSessionId="session-2"
          visibleSessionOrder={["session-1", "session-2"]}
        />
      </AppProviders>,
    );

    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(handleSelectSession).toHaveBeenLastCalledWith("session-1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
