import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionExportDialog } from "./SessionExportDialog";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 82,
    finishedAt: "2026-04-21T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/v1/some/really/long/path?with=long&query=string",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 1024,
    startedAt: "2026-04-21T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/v1/some/really/long/path?with=long&query=string",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    summary: createSessionSummary(),
    ...overrides,
  };
}

describe("SessionExportDialog", () => {
  it("renders a compact selected-session preview and supports host scope", () => {
    const selectedSession = createSessionSummary();

    render(
      <AppProviders>
        <SessionExportDialog
          allSessions={[selectedSession]}
          filteredSessions={[selectedSession]}
          hostScope={{
            host: "api.example.com",
            sessions: [selectedSession],
          }}
          initialScope="host"
          onClose={vi.fn()}
          open
          selectedSession={selectedSession}
          selectedSessionDetail={createSessionDetail()}
        />
      </AppProviders>,
    );

    expect(screen.getByText("Selected Domain")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(
      screen.getByText("/v1/some/really/long/path?with=long&query=string"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Selected Session"));

    expect(screen.getByText("GET")).toBeInTheDocument();
  });
});
