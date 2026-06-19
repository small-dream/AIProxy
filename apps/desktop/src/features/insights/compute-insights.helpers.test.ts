import { describe, expect, it } from "vitest";

import type { SessionSummary } from "@aiproxy/shared-types";

import {
  areSessionIdsEqual,
  computeInsightsFromSummaries,
  type InsightsComputationFilters,
} from "@/features/insights/compute-insights.helpers";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    method: "GET",
    host: "api.example.com",
    path: "/",
    protocol: "HTTP/1.1",
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:01.000Z",
    durationMs: 100,
    sizeBytes: 1000,
    statusCode: 200,
    url: "https://api.example.com/",
    ...overrides,
  };
}

function buildSummaries(count: number, host: string): SessionSummary[] {
  return Array.from({ length: count }, (_, index) =>
    summary({
      id: `${host}-${index}`,
      host,
      url: `https://${host}/${index}`,
      durationMs: (index + 1) * 10,
      sizeBytes: (index + 1) * 100,
    }),
  );
}

const unscoped: InsightsComputationFilters = {
  excludedHosts: [],
  hostExact: null,
  hostKeyword: "",
};

describe("computeInsightsFromSummaries", () => {
  it("caps slow/largest rankings at 20 in the unscoped overview", () => {
    const result = computeInsightsFromSummaries(buildSummaries(25, "api.example.com"), unscoped);

    expect(result.slowRequests).toHaveLength(20);
    expect(result.largestRequests).toHaveLength(20);
  });

  it("shows every request when scoped to a host (exact)", () => {
    const result = computeInsightsFromSummaries(buildSummaries(25, "api.example.com"), {
      ...unscoped,
      hostExact: "api.example.com",
    });

    expect(result.slowRequests).toHaveLength(25);
    expect(result.largestRequests).toHaveLength(25);
  });

  it("shows every request when scoped to a host (keyword)", () => {
    const result = computeInsightsFromSummaries(buildSummaries(25, "api.example.com"), {
      ...unscoped,
      hostKeyword: "api",
    });

    expect(result.slowRequests).toHaveLength(25);
  });

  it("excludes in-flight requests (status 0) from the status-code distribution", () => {
    const result = computeInsightsFromSummaries(
      [summary({ id: "a", statusCode: 200 }), summary({ id: "b", statusCode: 0 })],
      unscoped,
    );

    // The in-flight request still counts toward volume...
    expect(result.totalRequests).toBe(2);
    // ...but status code 0 is not a real HTTP status, so it is excluded.
    expect(result.byStatusCode).toEqual([{ statusCode: 200, count: 1 }]);
  });
});

describe("areSessionIdsEqual", () => {
  it("returns true for identical snapshots", () => {
    expect(areSessionIdsEqual(["s1", "s2"], ["s1", "s2"])).toBe(true);
  });

  it("returns true for two empty snapshots", () => {
    expect(areSessionIdsEqual([], [])).toBe(true);
  });

  it("returns false when the lengths differ", () => {
    expect(areSessionIdsEqual(["s1", "s2"], ["s1"])).toBe(false);
  });

  // Guards the P1 fix: switching to a different session set of the SAME length
  // must be detected so the stale backend result is not served for the whole
  // debounce window.
  it("returns false for same length but different ids", () => {
    expect(areSessionIdsEqual(["s1", "s2", "s3"], ["s4", "s5", "s6"])).toBe(false);
  });

  it("is order-sensitive", () => {
    expect(areSessionIdsEqual(["s1", "s2"], ["s2", "s1"])).toBe(false);
  });
});
