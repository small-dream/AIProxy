import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionContainerStore } from "./session-container.store";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { useSessionEvents } from "./use-session-events";
import { SESSIONS_QUERY_KEY } from "./use-sessions";
import {
  onSessionRemove,
  onSessionUpsert,
  onSessionsCleared,
  onSessionsRemoved,
} from "@/services/events";

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

/** The latest registered handlers, invoked directly (no flush wait) so tests
 * can interleave events inside the 100ms upsert-buffer window. */
function latestHandlers() {
  const [upsert] = vi.mocked(onSessionUpsert).mock.calls.at(-1) ?? [];
  const [remove] = vi.mocked(onSessionRemove).mock.calls.at(-1) ?? [];
  const [removed] = vi.mocked(onSessionsRemoved).mock.calls.at(-1) ?? [];
  const [cleared] = vi.mocked(onSessionsCleared).mock.calls.at(-1) ?? [];
  expect(upsert).toBeDefined();
  expect(remove).toBeDefined();
  expect(removed).toBeDefined();
  expect(cleared).toBeDefined();
  return {
    upsert: upsert as (summary: SessionSummary) => void,
    remove: remove as (sessionId: string) => void,
    removed: removed as (ids: string[]) => void,
    cleared: cleared as () => void,
  };
}

describe("useSessionEvents", () => {
  // The container store is module-level and shared across tests; stale ids
  // from an earlier test would let `emitUpsert`'s waitFor pass before the
  // 100ms flush timer has even fired.
  beforeEach(() => {
    useSessionContainerStore.getState().clearSessions();
  });

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

  // The backend refreshes its cached detail in place when an in-flight request
  // completes (the response body arrives), but the summary-only merge cannot
  // carry that body. The transition must schedule exactly one refetch so an
  // open inspector picks the body up instead of showing "empty body" forever.
  it("invalidates a cached detail exactly once when it completes", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });

    const detailKey = [SESSION_DETAIL_QUERY_KEY, "s-complete"];
    queryClient.setQueryData(detailKey, buildDetail(buildSummary("s-complete", { statusCode: 0 })));

    await emitUpsert(buildSummary("s-complete", { statusCode: 200 }));
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData<SessionDetail>(detailKey)?.summary.statusCode).toBe(200);

    // Trailing upserts for the already-completed session must not re-invalidate.
    await emitUpsert(buildSummary("s-complete", { durationMs: 150 }));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  // A completed session receiving further cosmetic updates (duration refresh)
  // never passes through the in-flight→completed transition, so its cached
  // detail stays fresh and merge-only.
  it("keeps merging without invalidating for details cached post-completion", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });

    const detailKey = [SESSION_DETAIL_QUERY_KEY, "s-post"];
    queryClient.setQueryData(detailKey, buildDetail(buildSummary("s-post", { statusCode: 200 })));

    await emitUpsert(buildSummary("s-post", { durationMs: 250 }));
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData<SessionDetail>(detailKey)?.summary.durationMs).toBe(250);
  });

  // P1-15: upserts flush on a 100ms timer while removes apply immediately. A
  // summary buffered BEFORE the remove must not flush AFTER it and resurrect
  // the deleted session in the store or the sessions query cache.
  it("does not resurrect a session removed while its upsert was still buffered", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.upsert(buildSummary("s-race"));
    handlers.remove("s-race");

    // Let the 100ms flush timer fire.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(useSessionContainerStore.getState().activeSessionIds).not.toContain("s-race");
    const sessions = queryClient.getQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY) ?? [];
    expect(sessions.some((s) => s.id === "s-race")).toBe(false);
  });

  // The remove only filters its own id out of the buffer; upserts for other
  // sessions buffered in the same window must still flush.
  it("keeps buffered upserts for sessions that were not removed", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.upsert(buildSummary("s-keep"));
    handlers.upsert(buildSummary("s-drop"));
    handlers.remove("s-drop");

    await waitFor(() => {
      expect(useSessionContainerStore.getState().activeSessionIds).toContain("s-keep");
    });
    expect(useSessionContainerStore.getState().activeSessionIds).not.toContain("s-drop");
  });

  // Batch removals filter every listed id out of the pending buffer.
  it("drops buffered upserts for ids in a batch removal", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.upsert(buildSummary("s-b1"));
    handlers.upsert(buildSummary("s-b2"));
    handlers.removed(["s-b1", "s-b2"]);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const ids = useSessionContainerStore.getState().activeSessionIds;
    expect(ids).not.toContain("s-b1");
    expect(ids).not.toContain("s-b2");
  });

  it("can schedule a later upsert after a removal emptied the buffer", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.upsert(buildSummary("s-first"));
    handlers.remove("s-first");

    // Let the now-empty timer fire. A stale flushTimer would prevent the next
    // upsert from scheduling its own timer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    handlers.upsert(buildSummary("s-second"));
    await waitFor(() => {
      expect(useSessionContainerStore.getState().activeSessionIds).toContain("s-second");
    });
  });

  it("ignores an upsert that arrives after a session was removed", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.remove("s-tombstone");
    handlers.upsert(buildSummary("s-tombstone"));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(useSessionContainerStore.getState().activeSessionIds).not.toContain("s-tombstone");
  });

  it("ignores queued upserts after clear", async () => {
    const queryClient = new QueryClient();
    renderHook(() => useSessionEvents(), { wrapper: createWrapper(queryClient) });
    const handlers = latestHandlers();

    handlers.upsert(buildSummary("s-clear-race"));
    handlers.cleared();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(useSessionContainerStore.getState().activeSessionIds).not.toContain("s-clear-race");
  });
});
