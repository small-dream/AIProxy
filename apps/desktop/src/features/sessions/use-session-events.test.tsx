import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useSessionContainerStore } from "./session-container.store";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { useSessionEvents } from "./use-session-events";
import { onSessionUpsert } from "@/services/events";

vi.mock("@/services/events", () => ({
  onSessionUpsert: vi.fn(async () => () => {}),
  onSessionRemove: vi.fn(async () => () => {}),
  onSessionsCleared: vi.fn(async () => () => {}),
  onSessionsRemoved: vi.fn(async () => () => {}),
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function buildSummary(id: string, overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    id,
    method: "GET",
    host: "api.example.com",
    path: "/v1/test",
    protocol: "HTTP/1.1",
    scheme: "https",
    httpVersion: "1.1",
    transportProtocol: "tcp",
    applicationProtocol: "http",
    startedAt: "2026-06-08T00:00:00Z",
    finishedAt: "2026-06-08T00:00:01Z",
    durationMs: 100,
    sizeBytes: 1024,
    statusCode: 200,
    url: "https://api.example.com/v1/test",
    responseMimeType: "application/json",
    ...overrides,
  };
}

function buildDetail(summary: SessionSummary): SessionDetail {
  return {
    cookies: [],
    id: summary.id,
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    summary,
  };
}

/** Emit an upsert through the registered event handler and wait for the flush. */
async function emitUpsert(summary: SessionSummary) {
  const [handler] = vi.mocked(onSessionUpsert).mock.calls.at(-1) ?? [];
  expect(handler).toBeDefined();
  (handler as (summary: SessionSummary) => void)(summary);

  await waitFor(() => {
    expect(useSessionContainerStore.getState().activeSessionIds).toContain(summary.id);
  });
}

describe("useSessionEvents", () => {
  it("mounts without throwing", () => {
    const wrapper = createWrapper(new QueryClient());
    expect(() => renderHook(() => useSessionEvents(), { wrapper })).not.toThrow();
  });

  // P1-18: an upsert must merge into an ALREADY-CACHED detail in place rather
  // than invalidating it — the old invalidateQueries marked the entry stale on
  // every upsert of every session at batch frequency, forcing a refetch even
  // when nothing about the detail body changed.
  it("merges an upsert into a cached detail without invalidating it", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });

    const original = buildDetail(buildSummary("s1"));
    queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, "s1"], original);
    await emitUpsert(buildSummary("s1", { statusCode: 404 }));

    const detailKey = [SESSION_DETAIL_QUERY_KEY, "s1"];
    const cached = queryClient.getQueryData<SessionDetail>(detailKey);
    expect(cached?.summary.statusCode).toBe(404);
    expect(cached?.id).toBe("s1");
    // The merge keeps the entry fresh — no pending refetch is scheduled.
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
  });

  // No cached detail means no consumer: an inspector that opens later fetches
  // on mount, so writing a cache entry for every upserted session would just
  // grow the cache unboundedly.
  it("skips details that are not cached", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });

    await emitUpsert(buildSummary("unknown"));

    expect(
      queryClient
        .getQueryCache()
        .find({ exact: true, queryKey: [SESSION_DETAIL_QUERY_KEY, "unknown"] }),
    ).toBeUndefined();
  });
});
