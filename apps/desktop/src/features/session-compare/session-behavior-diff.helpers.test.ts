import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  buildSessionComparePayload,
  getAvailableDomains,
  normalizeEndpoint,
} from "./session-behavior-diff.helpers";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "request-1",
    method: "GET",
    host: "api.example.com",
    path: "/v1/users",
    protocol: "https",
    startedAt: "2026-05-14T00:00:00.000Z",
    finishedAt: "2026-05-14T00:00:00.100Z",
    durationMs: 100,
    sizeBytes: 128,
    statusCode: 200,
    url: "https://api.example.com/v1/users",
    ...overrides,
  };
}

describe("session-behavior-diff.helpers", () => {
  it("normalizes endpoints without noisy query parameters while preserving method-like keys", () => {
    expect(
      normalizeEndpoint(
        summary({
          method: "POST",
          host: "api.example.com",
          path: "/api/",
          url: "https://api.example.com/api/?_method=site.track_events&_device=abc&_full_version=1.2.3",
        }),
      ),
    ).toBe("POST api.example.com/api/ _method=site.track_events");
  });

  it("applies a shared domain filter to both sides", () => {
    const leftApi = summary({
      id: "left-api",
      host: "api.example.com",
      url: "https://api.example.com/v1/users",
    });
    const leftCdn = summary({
      id: "left-cdn",
      host: "cdn.example.com",
      url: "https://cdn.example.com/app.js",
    });
    const rightApi = summary({
      id: "right-api",
      host: "api.example.com",
      url: "https://api.example.com/v1/users",
    });

    const payload = buildSessionComparePayload(
      { id: "left", label: "Left", sessions: [leftApi, leftCdn] },
      { id: "right", label: "Right", sessions: [rightApi] },
      ["api.example.com"],
    );

    expect(getAvailableDomains([leftApi, leftCdn], [rightApi])).toEqual([
      "api.example.com",
      "cdn.example.com",
    ]);
    expect(payload.overview.left.requestCount).toBe(1);
    expect(payload.overview.right.requestCount).toBe(1);
    expect(payload.domains).toHaveLength(1);
    expect(payload.domains[0]?.domain).toBe("api.example.com");
  });

  it("summarizes overview, endpoint count deltas, and sequence differences", () => {
    const payload = buildSessionComparePayload(
      {
        id: "left",
        label: "Left",
        sessions: [
          summary({
            id: "left-1",
            method: "GET",
            path: "/config",
            url: "https://api.example.com/config",
            durationMs: 50,
          }),
          summary({
            id: "left-2",
            method: "POST",
            path: "/track",
            url: "https://api.example.com/track",
            statusCode: 204,
            durationMs: 20,
          }),
        ],
      },
      {
        id: "right",
        label: "Right",
        sessions: [
          summary({
            id: "right-1",
            method: "POST",
            path: "/track",
            url: "https://api.example.com/track",
            statusCode: 204,
            durationMs: 30,
          }),
          summary({
            id: "right-2",
            method: "POST",
            path: "/track",
            url: "https://api.example.com/track",
            statusCode: 204,
            durationMs: 40,
          }),
          summary({
            id: "right-3",
            method: "GET",
            path: "/books",
            url: "https://api.example.com/books",
            statusCode: 500,
            durationMs: 90,
          }),
        ],
      },
      [],
    );

    expect(payload.overview.left.requestCount).toBe(2);
    expect(payload.overview.right.requestCount).toBe(3);
    expect(payload.overview.right.failureCount).toBe(1);
    expect(
      payload.endpoints.find((row) => row.endpoint === "GET api.example.com/config"),
    ).toMatchObject({
      kind: "removed",
      leftCount: 1,
      rightCount: 0,
    });
    expect(
      payload.endpoints.find((row) => row.endpoint === "POST api.example.com/track"),
    ).toMatchObject({
      kind: "changed",
      leftCount: 1,
      rightCount: 2,
    });
    expect(payload.sequence.addedEndpoints).toContain("GET api.example.com/books");
    expect(payload.sequence.removedEndpoints).toContain("GET api.example.com/config");
    expect(payload.sequence.changedPositions.length).toBeGreaterThan(0);
    expect(payload.sequence.repeatedEndpoints).toContainEqual({
      endpoint: "POST api.example.com/track",
      leftCount: 1,
      rightCount: 2,
    });
  });
});
