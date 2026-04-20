import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionEvents } from "./use-session-events";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { SESSIONS_QUERY_KEY } from "./use-sessions";

const { onSessionUpsertMock, onSessionRemoveMock } = vi.hoisted(() => ({
  onSessionRemoveMock: vi.fn(),
  onSessionUpsertMock: vi.fn(),
}));

vi.mock("@/services/events", () => ({
  onSessionRemove: onSessionRemoveMock,
  onSessionUpsert: onSessionUpsertMock,
}));

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T16:00:01.000Z",
    host: "example.com",
    id: "session-1",
    method: "GET",
    path: "/health",
    protocol: "http",
    sizeBytes: 512,
    startedAt: "2026-04-11T16:00:00.000Z",
    statusCode: 200,
    url: "http://example.com/health",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [],
    requestHeaders: [{ name: "Host", value: "example.com" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    summary: createSessionSummary(),
    ...overrides,
  };
}

describe("useSessionEvents", () => {
  let upsertCallback: ((summary: SessionSummary) => void) | undefined;
  let removeCallback: ((sessionId: string) => void) | undefined;

  beforeEach(() => {
    upsertCallback = undefined;
    removeCallback = undefined;
    onSessionUpsertMock.mockReset();
    onSessionRemoveMock.mockReset();
    onSessionUpsertMock.mockImplementation((callback: (summary: SessionSummary) => void) => {
      upsertCallback = callback;
      return Promise.resolve(() => undefined);
    });
    onSessionRemoveMock.mockImplementation((callback: (sessionId: string) => void) => {
      removeCallback = callback;
      return Promise.resolve(() => undefined);
    });
  });

  it("updates session summaries and invalidates the matching detail query on upsert", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");
    const previousSummary = createSessionSummary({ statusCode: 200 });
    const nextSummary = createSessionSummary({ statusCode: 201 });
    const detail = createSessionDetail({ summary: previousSummary });

    queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, [previousSummary]);
    queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, previousSummary.id], detail);

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useSessionEvents(), { wrapper });

    await waitFor(() => expect(onSessionUpsertMock).toHaveBeenCalledTimes(1));

    act(() => {
      upsertCallback?.(nextSummary);
    });

    expect(queryClient.getQueryData(SESSIONS_QUERY_KEY)).toEqual([nextSummary]);
    await waitFor(() =>
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({
        exact: true,
        queryKey: [SESSION_DETAIL_QUERY_KEY, nextSummary.id],
      }),
    );
  });

  it("removes session summaries and detail queries on remove", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const summary = createSessionSummary();
    const detail = createSessionDetail({ summary });

    queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, [summary]);
    queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, summary.id], detail);

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useSessionEvents(), { wrapper });

    await waitFor(() => expect(onSessionRemoveMock).toHaveBeenCalledTimes(1));

    act(() => {
      removeCallback?.(summary.id);
    });

    expect(queryClient.getQueryData(SESSIONS_QUERY_KEY)).toEqual([]);
    await waitFor(() =>
      expect(queryClient.getQueryState([SESSION_DETAIL_QUERY_KEY, summary.id])).toBeUndefined(),
    );
  });
});
