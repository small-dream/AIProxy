import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { markTimedOutPendingSession, PENDING_SESSION_TIMEOUT_MS } from "./session-cache.helpers";

describe("markTimedOutPendingSession", () => {
  it("marks old pending sessions as gateway timeouts", () => {
    const startedAtMs = Date.parse("2026-06-01T00:00:00.000Z");
    const session = createSessionSummary({
      durationMs: 0,
      finishedAt: "2026-06-01T00:00:00.000Z",
      startedAt: "2026-06-01T00:00:00.000Z",
      statusCode: 0,
    });

    const actual = markTimedOutPendingSession(
      session,
      startedAtMs + PENDING_SESSION_TIMEOUT_MS + 1_000,
    );

    expect(actual.statusCode).toBe(504);
    expect(actual.durationMs).toBe(PENDING_SESSION_TIMEOUT_MS + 1_000);
    expect(actual.finishedAt).toBe("2026-06-01T00:02:01.000Z");
  });

  it("leaves fresh pending sessions unchanged", () => {
    const startedAtMs = Date.parse("2026-06-01T00:00:00.000Z");
    const session = createSessionSummary({
      startedAt: "2026-06-01T00:00:00.000Z",
      statusCode: 0,
    });

    expect(markTimedOutPendingSession(session, startedAtMs + 30_000)).toBe(session);
  });
});

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-06-01T00:00:01.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/api",
    protocol: "https",
    sizeBytes: 128,
    startedAt: "2026-06-01T00:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/api",
    ...overrides,
  };
}
