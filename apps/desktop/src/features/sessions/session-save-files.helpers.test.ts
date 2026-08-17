import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { getSaveableSessions, hasSaveTargetConflicts } from "./session-save-files.helpers";

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "example.com",
    id: "session-1",
    method: "GET",
    path: "/",
    protocol: "HTTP/1.1",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "http://example.com/",
    ...overrides,
  };
}

describe("getSaveableSessions", () => {
  it("drops WebSocket sessions, which are message streams rather than files", () => {
    const sessions = [
      createSessionSummary({ id: "http" }),
      createSessionSummary({ id: "ws", protocol: "wss" }),
      createSessionSummary({ id: "ws-mime", responseMimeType: "websocket" }),
    ];

    expect(getSaveableSessions(sessions).map((session) => session.id)).toEqual(["http"]);
  });
});

describe("hasSaveTargetConflicts", () => {
  it("reports no conflict for a single request", () => {
    expect(hasSaveTargetConflicts([createSessionSummary({ id: "a", path: "/a.json" })])).toBe(
      false,
    );
  });

  it("reports no conflict when every request maps to a distinct file", () => {
    const sessions = [
      createSessionSummary({ id: "a", path: "/static/app.js" }),
      createSessionSummary({ id: "b", path: "/static/style.css" }),
      createSessionSummary({ id: "c", path: "/static/img/logo.png" }),
    ];

    expect(hasSaveTargetConflicts(sessions)).toBe(false);
  });

  it("detects the same path captured twice", () => {
    const sessions = [
      createSessionSummary({ id: "first", path: "/static/app.js" }),
      createSessionSummary({ id: "second", path: "/static/app.js" }),
    ];

    expect(hasSaveTargetConflicts(sessions)).toBe(true);
  });

  it("treats query-only variants as a conflict, matching the backend's path derivation", () => {
    // The backend drops the query string, so both land on `list.json`.
    const sessions = [
      createSessionSummary({ id: "p1", path: "/list?page=1" }),
      createSessionSummary({ id: "p2", path: "/list?page=2" }),
    ];

    expect(hasSaveTargetConflicts(sessions)).toBe(true);
  });

  it("does not treat the same path on different hosts as a conflict", () => {
    const sessions = [
      createSessionSummary({ id: "a", host: "a.example.com", path: "/app.js" }),
      createSessionSummary({ id: "b", host: "b.example.com", path: "/app.js" }),
    ];

    expect(hasSaveTargetConflicts(sessions)).toBe(false);
  });
});
