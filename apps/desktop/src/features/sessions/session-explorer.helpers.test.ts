import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  buildSessionHostGroups,
  filterSessionsByHostKeyword,
  getSessionResourceKind,
  matchesKeyword,
  reconcileExpandedKeys,
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
  it("groups sessions by host and keeps host groups in first-seen order", () => {
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

    expect(groups.map((group) => group.host)).toEqual(["assets.example.com", "api.example.com"]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["session-2", "session-4"]);
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

  it("moves non-focused hosts into a single unfocused group", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-8",
          path: "/users",
          startedAt: "2026-04-11T10:00:08.000Z",
          url: "http://api.example.com/users",
        }),
        createSessionSummary({
          host: "assets.example.com",
          id: "session-9",
          path: "/logo.svg",
          startedAt: "2026-04-11T10:00:09.000Z",
          url: "http://assets.example.com/logo.svg",
        }),
        createSessionSummary({
          host: "cdn.example.com",
          id: "session-10",
          path: "/app.js",
          startedAt: "2026-04-11T10:00:10.000Z",
          url: "http://cdn.example.com/app.js",
        }),
      ],
      "",
      {
        focusedHosts: ["api.example.com"],
        unfocusedLabel: "UnFocus",
      },
    );

    expect(groups.map((group) => group.label)).toEqual(["api.example.com", "UnFocus"]);
    expect(groups[1]).toMatchObject({
      host: null,
      key: "__unfocused__",
      kind: "aggregate",
      tree: [
        { branchType: "host", host: "assets.example.com", segmentLabel: "assets.example.com" },
        { branchType: "host", host: "cdn.example.com", segmentLabel: "cdn.example.com" },
      ],
    });
  });

  it("keeps multiple focused hosts visible before the unfocused aggregate", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-16",
          path: "/users",
          startedAt: "2026-04-11T10:00:08.000Z",
          url: "http://api.example.com/users",
        }),
        createSessionSummary({
          host: "assets.example.com",
          id: "session-17",
          path: "/logo.svg",
          startedAt: "2026-04-11T10:00:09.000Z",
          url: "http://assets.example.com/logo.svg",
        }),
        createSessionSummary({
          host: "cdn.example.com",
          id: "session-18",
          path: "/app.js",
          startedAt: "2026-04-11T10:00:10.000Z",
          url: "http://cdn.example.com/app.js",
        }),
      ],
      "",
      {
        focusedHosts: ["api.example.com", "cdn.example.com"],
        unfocusedLabel: "UnFocus",
      },
    );

    expect(groups.map((group) => group.label)).toEqual([
      "api.example.com",
      "cdn.example.com",
      "UnFocus",
    ]);
    expect(groups[2]).toMatchObject({
      host: null,
      key: "__unfocused__",
      kind: "aggregate",
      tree: [
        { branchType: "host", host: "assets.example.com", segmentLabel: "assets.example.com" },
      ],
    });
  });

  it("builds a Charles-like host path tree", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-11",
          path: "/api/users/list",
          url: "http://api.example.com/api/users/list",
        }),
        createSessionSummary({
          host: "api.example.com",
          id: "session-12",
          path: "/api/users/detail?id=1",
          startedAt: "2026-04-11T10:00:08.000Z",
          url: "http://api.example.com/api/users/detail?id=1",
        }),
        createSessionSummary({
          host: "api.example.com",
          id: "session-13",
          path: "/health",
          url: "http://api.example.com/health",
        }),
      ],
      "",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tree).toMatchObject([
      {
        branchType: "path",
        kind: "branch",
        pathKey: "api",
        segmentLabel: "api",
        children: [
          {
            branchType: "path",
            kind: "branch",
            pathKey: "api/users",
            segmentLabel: "users",
            children: [
              { kind: "leaf", segmentLabel: "list", session: { id: "session-11" } },
              { kind: "leaf", segmentLabel: "detail", session: { id: "session-12" } },
            ],
          },
        ],
      },
      { kind: "leaf", segmentLabel: "health", session: { id: "session-13" } },
    ]);
  });

  it("groups single-segment directory requests with query strings under a folder branch", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-14",
          path: "/api?_method=site.track_events&_app=Android",
          url: "http://api.example.com/api?_method=site.track_events&_app=Android",
        }),
        createSessionSummary({
          host: "api.example.com",
          id: "session-15",
          path: "/api?_method=app.launch&_app=Android",
          startedAt: "2026-04-11T10:00:08.000Z",
          url: "http://api.example.com/api?_method=app.launch&_app=Android",
        }),
      ],
      "",
    );

    expect(groups[0]?.tree).toMatchObject([
      {
        branchType: "path",
        kind: "branch",
        pathKey: "api",
        segmentLabel: "api",
        children: [
          { kind: "leaf", segmentLabel: "", session: { id: "session-14" } },
          { kind: "leaf", segmentLabel: "", session: { id: "session-15" } },
        ],
      },
    ]);
  });

  it("drops stale expanded keys and keeps valid host or branch keys", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "api.example.com",
          id: "session-11",
          path: "/api/users",
          url: "http://api.example.com/api/users",
        }),
      ],
      "",
    );

    expect(reconcileExpandedKeys([], groups)).toEqual([]);
    expect(
      reconcileExpandedKeys(
        ["missing.example.com", "api.example.com", "api.example.com::api"],
        groups,
      ),
    ).toEqual(["api.example.com", "api.example.com::api"]);
  });

  it("keeps an expanded unfocused host open when focused sessions appear", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "assets.example.com",
          id: "session-20",
          path: "/api/users",
          url: "http://assets.example.com/api/users",
        }),
        createSessionSummary({
          host: "api.example.com",
          id: "session-21",
          path: "/focus",
          url: "http://api.example.com/focus",
        }),
      ],
      "",
      {
        focusedHosts: ["api.example.com"],
        unfocusedLabel: "UnFocus",
      },
    );

    expect(reconcileExpandedKeys(["assets.example.com"], groups)).toEqual([
      "__unfocused__",
      "__unfocused__::host:assets.example.com",
    ]);
    expect(
      reconcileExpandedKeys(["assets.example.com", "assets.example.com::api"], groups),
    ).toEqual([
      "__unfocused__",
      "__unfocused__::host:assets.example.com",
      "__unfocused__::host:assets.example.com/api",
    ]);
  });

  it("restores aggregate child expansions when focused sessions disappear", () => {
    const groups = buildSessionHostGroups(
      [
        createSessionSummary({
          host: "assets.example.com",
          id: "session-22",
          path: "/api/users",
          url: "http://assets.example.com/api/users",
        }),
      ],
      "",
      {
        focusedHosts: ["api.example.com"],
        unfocusedLabel: "UnFocus",
      },
    );

    expect(
      reconcileExpandedKeys(
        [
          "__unfocused__",
          "__unfocused__::host:assets.example.com",
          "__unfocused__::host:assets.example.com/api",
        ],
        groups,
      ),
    ).toEqual(["assets.example.com", "assets.example.com::api"]);
  });
});

describe("filterSessionsByHostKeyword", () => {
  it("keeps only sessions whose host matches the domain filter", () => {
    const sessions = [
      createSessionSummary({
        host: "api.example.com",
        id: "session-16",
        url: "http://api.example.com/users",
      }),
      createSessionSummary({
        host: "assets.example.com",
        id: "session-17",
        url: "http://assets.example.com/logo.svg",
      }),
    ];

    expect(filterSessionsByHostKeyword(sessions, "assets").map((session) => session.id)).toEqual([
      "session-17",
    ]);
  });

  it("returns the original sessions when the domain filter is empty", () => {
    const sessions = [
      createSessionSummary({ id: "session-18" }),
      createSessionSummary({ id: "session-19", host: "assets.example.com" }),
    ];

    expect(filterSessionsByHostKeyword(sessions, "")).toEqual(sessions);
  });
});

describe("getSessionResourceKind", () => {
  it("uses response mime type for successful requests", () => {
    expect(
      getSessionResourceKind(
        createSessionSummary({
          path: "/users",
          responseMimeType: "application/json; charset=utf-8",
          statusCode: 200,
        }),
      ),
    ).toBe("api");

    expect(
      getSessionResourceKind(
        createSessionSummary({
          path: "/app.css",
          responseMimeType: "text/css",
          statusCode: 200,
        }),
      ),
    ).toBe("css");
  });

  it("falls back to pending and warning states", () => {
    expect(getSessionResourceKind(createSessionSummary({ statusCode: 0 }))).toBe("pending");
    expect(getSessionResourceKind(createSessionSummary({ statusCode: 499 }))).toBe("cancelled");
    expect(getSessionResourceKind(createSessionSummary({ statusCode: 500 }))).toBe("warning");
  });
});

describe("matchesKeyword", () => {
  it("matches HTTP/2 sessions by httpVersion field", () => {
    const session = createSessionSummary({ protocol: "h2", httpVersion: "2" });
    expect(matchesKeyword(session, "2")).toBe(true);
    expect(matchesKeyword(session, "h2")).toBe(false);
  });
});
