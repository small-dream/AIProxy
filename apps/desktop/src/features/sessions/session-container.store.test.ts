import { describe, it, expect, beforeEach } from "vitest";
import type { SessionSummary } from "@aiproxy/shared-types";
import { useSessionContainerFilterStore, useSessionContainerStore } from "./session-container.store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Narrow an array element after checking length — avoids TS "possibly undefined". */
function at<T>(arr: T[], index: number): T {
  const value = arr[index];
  expect(value).toBeDefined();
  return value!;
}

// ---------------------------------------------------------------------------
// Legacy filter store (existing tests)
// ---------------------------------------------------------------------------

describe("SessionContainerFilterStore", () => {
  beforeEach(() => {
    useSessionContainerFilterStore.setState({ activeSessionIds: [] });
  });

  it("starts with empty session IDs", () => {
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual([]);
  });

  it("sets active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1", "s2"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s1", "s2"]);
  });

  it("replaces active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1"]);
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s3", "s4"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s3", "s4"]);
  });
});

// ---------------------------------------------------------------------------
// SessionContainerStore — public API
// ---------------------------------------------------------------------------

describe("SessionContainerStore", () => {
  beforeEach(() => {
    const store = useSessionContainerStore;
    store.getState().clearSessions();
  });

  describe("init", () => {
    it("creates a default container on first init", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      const state = store.getState();

      expect(state.hydrated).toBe(false);
      expect(state.containers).toHaveLength(1);
      expect(at(state.containers, 0).labelNumber).toBe(1);
    });

    it("applies custom options on init", () => {
      const store = useSessionContainerStore;
      store.getState().init({
        requestTab: "headers",
        responseTab: "overview",
        requestCollapsed: true,
      });
      const state = store.getState();
      const container = at(state.containers, 0);

      expect(container.requestTab).toBe("headers");
      expect(container.responseTab).toBe("overview");
      expect(container.requestCollapsed).toBe(true);
    });
  });

  describe("seedSessions", () => {
    it("seeds sessions into the container", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      const s1 = buildSummary("s1");
      const s2 = buildSummary("s2", { host: "other.example.com" });

      store.getState().seedSessions([s1, s2]);
      const state = store.getState();

      expect(state.sessionSummaryById["s1"]).toEqual(s1);
      expect(state.sessionSummaryById["s2"]).toEqual(s2);
      const container = at(state.containers, 0);
      expect(container.sessionIds).toContain("s1");
      expect(container.sessionIds).toContain("s2");
    });

    it("handles empty seed", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().seedSessions([]);
      const state = store.getState();

      expect(Object.keys(state.sessionSummaryById)).toHaveLength(0);
    });
  });

  describe("upsertSummary", () => {
    it("adds a new summary", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      const s1 = buildSummary("s1");

      store.getState().upsertSummary(s1);
      const state = store.getState();

      expect(state.sessionSummaryById["s1"]).toEqual(s1);
      expect(at(state.containers, 0).sessionIds).toContain("s1");
    });

    it("updates an existing summary", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().upsertSummary(buildSummary("s1", { statusCode: 200 }));
      store.getState().upsertSummary(buildSummary("s1", { statusCode: 404 }));

      const state = store.getState();
      expect(state.sessionSummaryById["s1"]!.statusCode).toBe(404);
      // Should not duplicate the session ID
      const occurrences = at(state.containers, 0).sessionIds.filter((id) => id === "s1").length;
      expect(occurrences).toBe(1);
    });
  });

  describe("addContainer", () => {
    it("creates an additional container with sequential label", () => {
      const store = useSessionContainerStore;
      store.getState().init();

      store.getState().addContainer();
      const state = store.getState();

      expect(state.containers).toHaveLength(2);
      expect(at(state.containers, 0).labelNumber).toBe(1);
      expect(at(state.containers, 1).labelNumber).toBe(2);
    });

    it("auto-selects the new container", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().addContainer();

      const state = store.getState();
      expect(state.activeContainerId).toBe(at(state.containers, 1).id);
    });
  });

  describe("closeContainer", () => {
    it("removes the specified container", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().addContainer();
      const before = store.getState();

      store.getState().closeContainer(at(before.containers, 0).id);
      const after = store.getState();

      expect(after.containers).toHaveLength(1);
      expect(at(after.containers, 0).id).toBe(at(before.containers, 1).id);
    });

    it("selects the remaining container", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().addContainer();
      const c1 = at(store.getState().containers, 0);

      store.getState().closeContainer(c1.id);
      const after = store.getState();

      expect(after.activeContainerId).toBe(at(after.containers, 0).id);
    });
  });

  describe("clearSessions", () => {
    it("resets to a clean state", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().seedSessions([buildSummary("s1"), buildSummary("s2")]);

      store.getState().clearSessions();
      const state = store.getState();

      expect(Object.keys(state.sessionSummaryById)).toHaveLength(0);
      expect(state.containers).toHaveLength(1);
      expect(at(state.containers, 0).sessionIds).toHaveLength(0);
    });
  });

  // --- Edge cases ---

  describe("concurrent upsert", () => {
    it("handles rapid upsert of the same session without duplicating IDs", () => {
      const store = useSessionContainerStore;
      store.getState().init();

      // Simulate rapid updates from real-time events
      for (let i = 0; i < 10; i++) {
        store.getState().upsertSummary(buildSummary("s1", { statusCode: 200 + i }));
      }

      const state = store.getState();
      expect(state.sessionSummaryById["s1"]!.statusCode).toBe(209);
      const occurrences = at(state.containers, 0).sessionIds.filter((id) => id === "s1").length;
      expect(occurrences).toBe(1);
    });

    it("handles interleaved upsert of different sessions", () => {
      const store = useSessionContainerStore;
      store.getState().init();

      // Interleave updates for multiple sessions
      for (let i = 0; i < 5; i++) {
        store.getState().upsertSummary(buildSummary(`s${i}`, { durationMs: 100 + i }));
      }
      for (let i = 0; i < 5; i++) {
        store.getState().upsertSummary(buildSummary(`s${i}`, { durationMs: 200 + i }));
      }

      const state = store.getState();
      for (let i = 0; i < 5; i++) {
        expect(state.sessionSummaryById[`s${i}`]!.durationMs).toBe(200 + i);
      }
      expect(at(state.containers, 0).sessionIds).toHaveLength(5);
    });

    it("handles upsert after clearSessions", () => {
      const store = useSessionContainerStore;
      store.getState().init();
      store.getState().upsertSummary(buildSummary("s1"));
      store.getState().clearSessions();
      store.getState().upsertSummary(buildSummary("s2"));

      const state = store.getState();
      expect(state.sessionSummaryById["s1"]).toBeUndefined();
      expect(state.sessionSummaryById["s2"]).toBeDefined();
    });
  });

  describe("large seed performance", () => {
    it("seeds 500 sessions without errors", () => {
      const store = useSessionContainerStore;
      store.getState().init();

      const summaries: SessionSummary[] = [];
      for (let i = 0; i < 500; i++) {
        summaries.push(buildSummary(`session-${i}`, { host: `host-${i % 10}.example.com`, durationMs: i }));
      }

      store.getState().seedSessions(summaries);

      const state = store.getState();
      expect(Object.keys(state.sessionSummaryById)).toHaveLength(500);
      expect(at(state.containers, 0).sessionIds).toHaveLength(500);
    });

    it("upserts 200 unique sessions efficiently", () => {
      const store = useSessionContainerStore;
      store.getState().init();

      for (let i = 0; i < 200; i++) {
        store.getState().upsertSummary(buildSummary(`s-${i}`));
      }

      const state = store.getState();
      expect(at(state.containers, 0).sessionIds).toHaveLength(200);
      expect(state.sessionSummaryById["s-0"]).toBeDefined();
      expect(state.sessionSummaryById["s-199"]).toBeDefined();
    });
  });
});
