import type { SessionSummary } from "@aiproxy/shared-types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useSessionContainerFilterStore } from "@/features/sessions/session-container.store";

import { InsightsPage } from "./insights";

const mockNavigate = vi.fn();
const mockSetHeaderActions = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");

  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useOutletContext: () => ({ setHeaderActions: mockSetHeaderActions }),
  };
});

vi.mock("@/services/commands/sessions", () => ({
  invokeGetInsights: vi.fn(async () => ({
    totalRequests: 0,
    totalErrors: 0,
    errorRate: 0,
    avgDurationMs: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    p99DurationMs: 0,
    totalBytes: 0,
    byHost: [],
    byStatusCode: [],
    byMethod: [],
    slowRequests: [],
  })),
}));

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    method: "GET",
    host: "api.example.com",
    path: "/users",
    protocol: "HTTP/1.1",
    startedAt: "2026-05-25T00:00:00.000Z",
    finishedAt: "2026-05-25T00:00:01.000Z",
    durationMs: 100,
    sizeBytes: 128,
    statusCode: 200,
    url: "https://api.example.com/users",
    ...overrides,
  };
}

function renderInsights() {
  return render(
    <AppProviders>
      <InsightsPage />
    </AppProviders>,
  );
}

async function findHostTableCell(host: string) {
  const matches = await screen.findAllByText(host);
  const tableCellMatch = matches.find((match) => match.closest("td"));

  if (!tableCellMatch) {
    throw new Error(`Could not find host table cell for ${host}`);
  }

  return tableCellMatch;
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockSetHeaderActions.mockReset();
  useSessionContainerFilterStore.setState({
    activeSessionIds: ["session-1", "session-2", "session-3"],
    activeSessionSummaries: [
      summary({ id: "session-1", host: "api.example.com", url: "https://api.example.com/users" }),
      summary({
        id: "session-2",
        host: "api.example.com",
        statusCode: 500,
        url: "https://api.example.com/errors",
      }),
      summary({ id: "session-3", host: "cdn.example.com", url: "https://cdn.example.com/app.js" }),
    ],
  });
});

afterEach(() => {
  useSessionContainerFilterStore.setState({
    activeSessionIds: [],
    activeSessionSummaries: [],
  });
  vi.restoreAllMocks();
});

describe("InsightsPage host filters", () => {
  it("filters and excludes hosts from the host context menu", async () => {
    renderInsights();

    expect(await findHostTableCell("api.example.com")).toBeInTheDocument();
    expect(await findHostTableCell("cdn.example.com")).toBeInTheDocument();

    fireEvent.contextMenu(await findHostTableCell("api.example.com"), {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(await screen.findByText("Filter by this host"));

    await waitFor(() => {
      expect(screen.getByText("host = api.example.com")).toBeInTheDocument();
      expect(screen.queryByText("cdn.example.com")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Clear filters"));

    expect(await findHostTableCell("cdn.example.com")).toBeInTheDocument();

    fireEvent.contextMenu(await findHostTableCell("cdn.example.com"), {
      clientX: 120,
      clientY: 180,
    });
    fireEvent.click(await screen.findByText("Exclude this host"));

    await waitFor(() => {
      expect(screen.getByText("host != cdn.example.com")).toBeInTheDocument();
      expect(screen.queryByText("cdn.example.com")).not.toBeInTheDocument();
    });
  });

  it("uses selected host text as a contains filter", async () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "api",
    } as Selection);

    renderInsights();

    fireEvent.contextMenu(await findHostTableCell("api.example.com"), {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(await screen.findByText("Filter by selected text"));

    await waitFor(() => {
      expect(screen.getByText("host contains api")).toBeInTheDocument();
      expect(screen.queryByText("cdn.example.com")).not.toBeInTheDocument();
    });
  });

  it("opens Sessions with the selected host filter", async () => {
    renderInsights();

    fireEvent.contextMenu(await findHostTableCell("api.example.com"), {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(await screen.findByText("Show requests for this host"));

    expect(mockNavigate).toHaveBeenCalledWith("/", {
      state: {
        sessionHostFilter: {
          host: "api.example.com",
          requestedAt: expect.any(Number) as number,
        },
      },
    });
  });
});
