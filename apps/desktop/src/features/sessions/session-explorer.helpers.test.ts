import type { SessionSummary } from "@pharles/shared-types";
import { describe, expect, it } from "vitest";

import {
  buildSessionHostGroups,
  reconcileExpandedHosts,
} from "./session-explorer.helpers";

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

describe("buildSessionHostGroups", () => {
  it("groups sessions by host and keeps host groups in stable alphabetical order", () => {
    const sessions = [
      createSessionSummary({
        host: "assets.example.com",
        id: "session-2",
        path: "/logo.svg",
        startedAt: "2026-04-11T10:00:01.000Z",
        url: "http://assets.example.com/logo.svg",
      }),
      createSessionSummary({
        host: "api.example.com",
        id: "session-3",
        path: "/v1/users",
        startedAt: "2026-04-11T10:00:05.000Z",
        url: "http://api.example.com/v1/users",
      }),
      createSessionSummary({
        host: "assets.example.com",
        id: "session-4",
        path: "/fonts.woff2",
        startedAt: "2026-04-11T10:00:06.000Z",
        url: "http://assets.example.com/fonts.woff2",
      }),
    ];

    const groups = buildSessionHostGroups(sessions, "");

    expect(groups.map((group) => group.host)).toEqual(["api.example.com", "assets.example.com"]);
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["session-4", "session-2"]);
  });

  it("filters sessions by keyword", () => {
    const sessions = [
      createSessionSummary({
        host: "api.example.com",
        id: "session-5",
        path: "/users",
        statusCode: 200,
        url: "http://api.example.com/users",
      }),
      createSessionSummary({
        host: "api.example.com",
        id: "session-6",
        path: "/error",
        statusCode: 502,
        url: "http://api.example.com/error",
      }),
      createSessionSummary({
        host: "socket.example.com",
        id: "session-7",
        path: "/connect",
        protocol: "WS",
        statusCode: 101,
        url: "ws://socket.example.com/connect",
      }),
    ];

    const groups = buildSessionHostGroups(sessions, "error");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.host).toBe("api.example.com");
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["session-6"]);
  });

  it("keeps the host tree collapsed by default and drops stale expansions", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-8",
          url: "http://api.example.com/users",
        }),
      ],
      "",
    );

    expect(reconcileExpandedHosts([], groups)).toEqual([]);
    expect(reconcileExpandedHosts(["missing.example.com", "api.example.com"], groups)).toEqual([
      "api.example.com",
    ]);
  });
});
