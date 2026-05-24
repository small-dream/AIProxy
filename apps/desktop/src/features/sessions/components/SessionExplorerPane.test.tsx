import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

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

describe("SessionExplorerPane", () => {
  it("renders a JSON icon for successful JSON responses", () => {
    const groups = buildSessionHostGroups([createSessionSummary({})], "");

    render(
      <AppProviders>
        <SessionExplorerPane
          domainFilterValue=""
          errorMessage={undefined}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
          isLoading={false}
          onDomainFilterChange={() => {}}
          onSelectSession={() => {}}
          onToggleHost={() => {}}
          selectedSessionId={undefined}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("json-file-icon")).toBeInTheDocument();
  });

  it("renders a focus icon for focused hosts and a separate icon for the unfocused aggregate", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({ host: "api.example.com", id: "session-1", url: "http://api.example.com/users" }),
        createSessionSummary({ host: "cdn.example.com", id: "session-2", url: "http://cdn.example.com/app.js", path: "/app.js" }),
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
          domainFilterValue=""
          errorMessage={undefined}
          expandedHosts={groups.map((group) => group.key)}
          groups={groups}
          isLoading={false}
          onDomainFilterChange={() => {}}
          onSelectSession={() => {}}
          onToggleHost={() => {}}
          selectedSessionId={undefined}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("focused-host-icon")).toBeInTheDocument();
    expect(screen.getByTestId("unfocused-group-icon")).toBeInTheDocument();
    expect(screen.getByTestId("aggregate-host-icon")).toBeInTheDocument();
  });

  it("renders the bottom domain filter and forwards changes", () => {
    const handleDomainFilterChange = vi.fn();

    render(
      <AppProviders>
        <SessionExplorerPane
          domainFilterValue="api"
          errorMessage={undefined}
          expandedHosts={[]}
          groups={[]}
          isLoading={false}
          onDomainFilterChange={handleDomainFilterChange}
          onSelectSession={() => {}}
          onToggleHost={() => {}}
          selectedSessionId={undefined}
        />
      </AppProviders>,
    );

    const input = screen.getByPlaceholderText("Filter");
    expect(input).toHaveValue("api");

    fireEvent.change(input, { target: { value: "assets" } });

    expect(handleDomainFilterChange).toHaveBeenCalledWith("assets");
  });
});
