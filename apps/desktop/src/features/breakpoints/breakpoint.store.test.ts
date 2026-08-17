import type { BreakpointHit } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it } from "vitest";

import { useBreakpointStore } from "./breakpoint.store";

function createHit(overrides: Partial<BreakpointHit> = {}): BreakpointHit {
  return {
    host: "api.example.com",
    method: "POST",
    path: "/launch",
    requestHeaders: [],
    sessionId: "breakpoint-1",
    stage: "request",
    url: "https://api.example.com/launch",
    ...overrides,
  };
}

describe("useBreakpointStore", () => {
  beforeEach(() => {
    useBreakpointStore.setState({ activeHitId: null, pendingHits: [], rules: [] });
  });

  it("keeps pending breakpoint hits unique by session id", () => {
    const firstHit = createHit({ path: "/first" });
    const duplicateHit = createHit({ path: "/updated" });

    useBreakpointStore.getState().addPendingHit(firstHit);
    useBreakpointStore.getState().addPendingHit(duplicateHit);

    expect(useBreakpointStore.getState().pendingHits).toEqual([
      expect.objectContaining({
        ...duplicateHit,
        receivedAt: expect.any(Number),
      }),
    ]);
    expect(useBreakpointStore.getState().activeHitId).toBe("breakpoint-1");
  });

  it("does not inflate the pending count when multiple hits repeat", () => {
    const firstHit = createHit({ sessionId: "breakpoint-1" });
    const secondHit = createHit({ sessionId: "breakpoint-2" });

    useBreakpointStore.getState().addPendingHit(firstHit);
    useBreakpointStore.getState().addPendingHit(secondHit);
    useBreakpointStore.getState().addPendingHit(firstHit);
    useBreakpointStore.getState().addPendingHit(secondHit);

    expect(useBreakpointStore.getState().pendingHits).toHaveLength(2);
    expect(useBreakpointStore.getState().pendingHits.map((hit) => hit.sessionId)).toEqual([
      "breakpoint-1",
      "breakpoint-2",
    ]);
  });
});
