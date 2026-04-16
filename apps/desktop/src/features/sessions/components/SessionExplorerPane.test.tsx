import { render, screen } from "@testing-library/react";
import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { buildSessionHostGroups } from "../session-explorer.helpers";
import { SessionExplorerPane } from "./SessionExplorerPane";

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
          errorMessage={undefined}
          expandedHosts={[groups[0]!.key]}
          groups={groups}
          isLoading={false}
          onSelectSession={() => {}}
          onToggleHost={() => {}}
          selectedSessionId={undefined}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("json-file-icon")).toBeInTheDocument();
  });
});
