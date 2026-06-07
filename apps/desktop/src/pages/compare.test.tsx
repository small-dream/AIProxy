import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { AppProviders } from "@/app/providers/AppProviders";
import {
  clearImportedSessions,
  upsertImportedSessions,
} from "@/features/sessions/imported-sessions.store";
import { syncSessionCompareScopes } from "@/features/sessions/session-scope-registry";

import { ComparePage } from "./compare";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "left",
    method: "GET",
    host: "api.example.com",
    path: "/users",
    protocol: "https",
    startedAt: "2026-05-14T00:00:00.000Z",
    finishedAt: "2026-05-14T00:00:01.000Z",
    durationMs: 100,
    sizeBytes: 128,
    statusCode: 200,
    url: "https://api.example.com/users",
    ...overrides,
  };
}

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const baseSummary = overrides.summary ?? summary();
  return {
    id: baseSummary.id,
    summary: baseSummary,
    cookies: [],
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    ...overrides,
  };
}

function renderCompare(left: SessionDetail, right: SessionDetail) {
  upsertImportedSessions([left, right]);

  return renderCompareRoute(`/compare?left=${left.id}&right=${right.id}`);
}

function renderCompareRoute(route: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[route]}>
        <ComparePage />
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => {
  clearImportedSessions();
  syncSessionCompareScopes([]);
});

describe("ComparePage", () => {
  it("shows collapsed body state and computes body diff on demand", async () => {
    renderCompare(
      detail({
        requestBody: {
          inlineText: JSON.stringify({ user: { name: "Ada" } }),
          mimeType: "application/json",
          sizeBytes: 23,
        },
      }),
      detail({
        summary: summary({ id: "right" }),
        requestBody: {
          inlineText: JSON.stringify({ user: { name: "Grace" } }),
          mimeType: "application/json",
          sizeBytes: 25,
        },
      }),
    );

    expect(await screen.findByText(/Body detail is collapsed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compute body diff" }));

    expect(await screen.findByText("$.user.name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse body diff" })).toBeInTheDocument();
  });

  it("explains binary body state instead of saying there is no body", async () => {
    renderCompare(
      detail({
        responseBody: {
          mimeType: "application/octet-stream",
          sizeBytes: 12,
        },
      }),
      detail({
        summary: summary({ id: "right" }),
        responseBody: {
          mimeType: "application/octet-stream",
          sizeBytes: 16,
        },
      }),
    );

    expect(await screen.findByText(/not available as renderable text/)).toBeInTheDocument();
    expect(screen.getAllByText("Non-text or binary")).toHaveLength(2);
  });

  it("surfaces body truncation and lets visible changes expand", async () => {
    const leftBody = Array.from({ length: 250 }, (_, index) => `left-${index}`).join("\n");
    const rightBody = Array.from({ length: 250 }, (_, index) => `right-${index}`).join("\n");

    renderCompare(
      detail({
        requestBody: {
          inlineText: leftBody,
          mimeType: "text/plain",
          sizeBytes: leftBody.length,
        },
      }),
      detail({
        summary: summary({ id: "right" }),
        requestBody: {
          inlineText: rightBody,
          mimeType: "text/plain",
          sizeBytes: rightBody.length,
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compute body diff" }));

    expect(await screen.findByText("Showing the first 240 body diff entries.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all 240 changes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all 240 changes" }));

    const requestBodySection = screen.getByText("Request Body").closest(".MuiPaper-root");
    expect(requestBodySection).not.toBeNull();
    expect(within(requestBodySection as HTMLElement).getByText("line 240")).toBeInTheDocument();
  });

  it("renders session behavior comparison and previews a session payload", async () => {
    const leftApi = detail({
      summary: summary({
        id: "left-api",
        method: "GET",
        host: "api.example.com",
        path: "/config",
        url: "https://api.example.com/config",
      }),
    });
    const leftCdn = detail({
      summary: summary({
        id: "left-cdn",
        method: "GET",
        host: "cdn.example.com",
        path: "/asset.js",
        url: "https://cdn.example.com/asset.js",
      }),
    });
    const rightApi = detail({
      summary: summary({
        id: "right-api",
        method: "POST",
        host: "api.example.com",
        path: "/api/",
        statusCode: 204,
        url: "https://api.example.com/api/?_method=site.track_events&_device=abc",
      }),
    });

    upsertImportedSessions([leftApi, leftCdn, rightApi]);
    syncSessionCompareScopes([
      {
        id: "scope-left",
        label: "Session 1",
        sessionIds: ["left-api", "left-cdn"],
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
      {
        id: "scope-right",
        label: "Session 2",
        sessionIds: ["right-api"],
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    ]);

    renderCompareRoute(
      "/compare?mode=session&leftScope=scope-left&rightScope=scope-right&domains=api.example.com",
    );

    expect(await screen.findByText("Behavior Workbench")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getAllByText("Domains").length).toBeGreaterThan(0);
    expect(screen.getByText("Endpoints")).toBeInTheDocument();
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("Sequence")).toBeInTheDocument();
    expect((await screen.findAllByText("GET api.example.com/config")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("POST api.example.com/api/ _method=site.track_events")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("cdn.example.com")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview AI Payload" }));

    expect(await screen.findByText(/"compareMode": "session"/)).toBeInTheDocument();
    expect(screen.getByText(/"domainFilter":/)).toBeInTheDocument();
  });
});
