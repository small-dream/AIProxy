import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionInspectorWorkspace } from "./SessionInspectorWorkspace";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 165,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "POST",
    path: "/books",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/books",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [{ name: "page", value: "1" }],
    rawRequest: "POST /books HTTP/1.1",
    rawResponse: "HTTP/1.1 200 OK",
    requestBody: {
      inlineText: "{\"title\":\"AI\"}",
      mimeType: "application/json",
      sizeBytes: 14,
    },
    requestHeaders: [{ name: "content-type", value: "application/json" }],
    responseBody: {
      inlineText: "{\"ok\":true}",
      mimeType: "application/json",
      sizeBytes: 11,
    },
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    summary: createSessionSummary(),
    ...overrides,
  };
}

describe("SessionInspectorWorkspace", () => {
  it("renders the draggable splitter and forwards pointer down events", () => {
    const handleInspectorResizeStart = vi.fn();

    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={handleInspectorResizeStart}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="headers"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const grid = screen.getByTestId("session-inspector-grid");
    const splitter = screen.getByTestId("session-inspector-splitter");

    expect(grid).toHaveStyle({ gridTemplateRows: "0.4fr 8px 0.6fr" });

    fireEvent.pointerDown(splitter, { clientY: 200, pointerId: 1 });

    expect(handleInspectorResizeStart).toHaveBeenCalledTimes(1);
  });

  it("hides the splitter and uses the collapsed layout when the request pane is collapsed", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed
          requestTab="headers"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(screen.queryByTestId("session-inspector-splitter")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-inspector-grid")).toHaveStyle({
      gridTemplateRows: "auto 1px minmax(0, 1fr)",
    });
  });
});
