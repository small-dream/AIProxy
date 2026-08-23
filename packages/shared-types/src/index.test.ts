import { describe, expect, it } from "vitest";

import {
  coerceAppError,
  createDefaultProxyStatus,
  createMockComposeSessionDetail,
  DEFAULT_PROXY_PORT,
  INVALID_WS_MESSAGES,
  isAppError,
  isSessionDetail,
  isProxyStatus,
  isPortOccupant,
  isSessionSummary,
  isUpstreamProxyProtocol,
  isSslProxyingSettings,
  isRewriteRule,
  normalizeRewriteRule,
  parseSslProxyingExclusions,
  isUpstreamProxySettings,
  normalizeStartProxyInput,
  parseRewriteRules,
  parseSessionDetail,
  parseSessionSummary,
  parseSessionSummaries,
  parseProxyStatus,
  parsePortOccupant,
  parseRemoveCertificateTrustOutput,
  parseUpstreamProxyProbeResult,
  parseWsMessages,
} from "./index";

function makeRewriteRuleBase() {
  return {
    id: "rule-1",
    workspaceId: "default",
    name: "Rule",
    enabled: true,
    priority: 100,
    note: "",
    match: { urlPattern: "example.com", methods: [], stage: "either" },
  };
}

describe("rewrite rule normalization (D2)", () => {
  it("accepts the new actions shape and derives rewriteType from actions[0]", () => {
    const value = {
      ...makeRewriteRuleBase(),
      actions: [
        {
          rewriteType: "header",
          payload: { target: "request", operation: "set", headerName: "x", value: "1" },
        },
        { rewriteType: "query", payload: { operation: "set", paramName: "p", value: "v" } },
      ],
      rewriteType: "header",
    };

    const normalized = normalizeRewriteRule(value);
    expect(normalized).not.toBeNull();
    expect(normalized?.actions).toHaveLength(2);
    expect(normalized?.rewriteType).toBe("header");
    expect(isRewriteRule(value)).toBe(true);
  });

  it("lazily upgrades the legacy rewriteType + payload shape", () => {
    const value = {
      ...makeRewriteRuleBase(),
      rewriteType: "body",
      payload: {
        contentType: "application/json",
        mode: "replace",
        target: "response",
        text: "{}",
      },
    };

    const normalized = normalizeRewriteRule(value);
    expect(normalized).not.toBeNull();
    expect(normalized?.actions).toEqual([{ rewriteType: "body", payload: value.payload }]);
    expect(normalized?.rewriteType).toBe("body");
  });

  it("rejects malformed rules in any shape", () => {
    expect(normalizeRewriteRule({ ...makeRewriteRuleBase(), actions: [] })).toBeNull();
    expect(
      normalizeRewriteRule({
        ...makeRewriteRuleBase(),
        rewriteType: "header",
        payload: { operation: "set" },
      }),
    ).toBeNull();
    expect(normalizeRewriteRule(null)).toBeNull();
  });

  it("parseRewriteRules normalizes mixed legacy + new arrays", () => {
    const parsed = parseRewriteRules([
      {
        ...makeRewriteRuleBase(),
        actions: [
          {
            rewriteType: "redirect",
            payload: { targetUrl: "https://x", preservePath: true, preserveQuery: true },
          },
        ],
        rewriteType: "redirect",
      },
      {
        ...makeRewriteRuleBase(),
        id: "rule-2",
        rewriteType: "header",
        payload: { target: "request", operation: "remove", headerName: "x" },
      },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.actions[0]?.rewriteType).toBe("redirect");
    expect(parsed[1]?.actions[0]?.rewriteType).toBe("header");
  });
});

describe("isAppError", () => {
  it("returns true for a valid app error", () => {
    const actual = isAppError({
      code: "PORT_IN_USE",
      message: "The selected port is already in use.",
    });

    expect(actual).toBe(true);
  });

  it("returns false for an invalid app error shape", () => {
    const actual = isAppError({
      code: "PORT_IN_USE",
    });

    expect(actual).toBe(false);
  });
});

describe("coerceAppError", () => {
  it("preserves an existing app error", () => {
    const actual = coerceAppError({
      code: "INVALID_INPUT",
      message: "Workspace name is required.",
    });

    expect(actual).toEqual({
      code: "INVALID_INPUT",
      message: "Workspace name is required.",
    });
  });

  it("maps Error instances to an unknown error code", () => {
    const actual = coerceAppError(new Error("Proxy startup failed."));

    expect(actual).toEqual({
      code: "UNKNOWN_ERROR",
      message: "Proxy startup failed.",
    });
  });

  it("preserves string messages from command failures", () => {
    const actual = coerceAppError("Port 8888 is already in use.");

    expect(actual).toEqual({
      code: "UNKNOWN_ERROR",
      message: "Port 8888 is already in use.",
    });
  });

  it("parses app errors serialized as JSON strings", () => {
    const actual = coerceAppError(
      JSON.stringify({
        code: "PORT_IN_USE",
        message: "The selected port is already in use.",
        details: {
          port: 8888,
        },
      }),
    );

    expect(actual).toEqual({
      code: "PORT_IN_USE",
      message: "The selected port is already in use.",
      details: {
        port: 8888,
      },
    });
  });

  it("returns a default message for non-error values", () => {
    const actual = coerceAppError(undefined);

    expect(actual).toEqual({
      code: "UNKNOWN_ERROR",
      message: "An unexpected error occurred.",
      details: {
        receivedType: "undefined",
      },
    });
  });
});

describe("isProxyStatus", () => {
  it("returns true for a valid proxy status", () => {
    const actual = isProxyStatus(createDefaultProxyStatus());

    expect(actual).toBe(true);
  });

  it("returns false for an invalid proxy status payload", () => {
    const actual = isProxyStatus({
      port: 0,
      running: true,
      sslEnabled: true,
      systemProxyEnabled: false,
    });

    expect(actual).toBe(false);
  });
});

describe("parseProxyStatus", () => {
  it("returns a valid proxy status payload unchanged", () => {
    const payload = createDefaultProxyStatus();

    const actual = parseProxyStatus(payload);

    expect(actual).toEqual(payload);
  });

  it("normalizes nullable optional fields from the Tauri command layer", () => {
    const actual = parseProxyStatus({
      activeWorkspaceId: null,
      port: DEFAULT_PROXY_PORT,
      running: false,
      sslEnabled: false,
      startedAt: null,
      systemProxyEnabled: false,
    });

    expect(actual).toEqual({
      port: DEFAULT_PROXY_PORT,
      running: false,
      sslEnabled: false,
      systemProxyEnabled: false,
    });
  });

  it("parses http2Enabled from the Tauri command layer", () => {
    const actual = parseProxyStatus({
      port: DEFAULT_PROXY_PORT,
      running: true,
      sslEnabled: true,
      http2Enabled: true,
      systemProxyEnabled: false,
    });

    expect(actual.http2Enabled).toBe(true);
  });

  it("omits http2Enabled when null from the Tauri command layer", () => {
    const actual = parseProxyStatus({
      port: DEFAULT_PROXY_PORT,
      running: true,
      sslEnabled: true,
      http2Enabled: null,
      systemProxyEnabled: false,
    });

    expect(actual.http2Enabled).toBeUndefined();
  });

  it("throws an app error when the payload is invalid", () => {
    expect(() =>
      parseProxyStatus({
        running: true,
      }),
    ).toThrow();
  });
});

describe("normalizeStartProxyInput", () => {
  it("fills the default port and ssl values", () => {
    const actual = normalizeStartProxyInput({
      workspaceId: " default-workspace ",
    });

    expect(actual).toEqual({
      enableHttp2: true,
      enableSsl: true,
      port: DEFAULT_PROXY_PORT,
      workspaceId: "default-workspace",
    });
  });
});

describe("isPortOccupant", () => {
  it("accepts a positive integer pid and non-empty name", () => {
    expect(isPortOccupant({ pid: 48213, name: "node" })).toBe(true);
  });

  it("rejects zero or negative pid", () => {
    expect(isPortOccupant({ pid: 0, name: "node" })).toBe(false);
    expect(isPortOccupant({ pid: -1, name: "node" })).toBe(false);
  });

  it("rejects non-integer pid", () => {
    expect(isPortOccupant({ pid: 1.5, name: "node" })).toBe(false);
  });

  it("rejects empty or missing name", () => {
    expect(isPortOccupant({ pid: 1, name: "" })).toBe(false);
    expect(isPortOccupant({ pid: 1, name: "   " })).toBe(false);
    expect(isPortOccupant({ pid: 1 })).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(isPortOccupant(null)).toBe(false);
    expect(isPortOccupant("node")).toBe(false);
    expect(isPortOccupant({})).toBe(false);
  });
});

describe("parsePortOccupant", () => {
  it("returns a typed occupant for valid input", () => {
    expect(parsePortOccupant({ pid: 48213, name: "node" })).toEqual({
      pid: 48213,
      name: "node",
    });
  });

  it("returns null for malformed input", () => {
    expect(parsePortOccupant({ pid: 0, name: "x" })).toBeNull();
    expect(parsePortOccupant(null)).toBeNull();
    expect(parsePortOccupant({ pid: 1 })).toBeNull();
  });
});

describe("createMockComposeSessionDetail", () => {
  it("uses one id for the detail and summary", () => {
    const detail = createMockComposeSessionDetail({
      body: '{"ok":true}',
      headers: [{ name: "Content-Type", value: "application/json" }],
      method: "POST",
      url: "https://api.example.com/orders",
      workspaceId: "default",
    });

    expect(detail.summary.id).toBe(detail.id);
  });
});

describe("isSessionSummary", () => {
  it("returns true for a valid captured session", () => {
    const actual = isSessionSummary({
      durationMs: 42,
      finishedAt: "2026-04-11T16:00:01.000Z",
      host: "example.com",
      id: "session-1",
      method: "GET",
      path: "/health",
      protocol: "http",
      scheme: "http",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http",
      sizeBytes: 512,
      startedAt: "2026-04-11T16:00:00.000Z",
      statusCode: 200,
      url: "http://example.com/health",
    });

    expect(actual).toBe(true);
  });

  it("keeps legacy session summaries without structured protocol metadata valid", () => {
    const actual = isSessionSummary({
      durationMs: 42,
      finishedAt: "2026-04-11T16:00:01.000Z",
      host: "example.com",
      id: "session-legacy",
      method: "GET",
      path: "/health",
      protocol: "http",
      sizeBytes: 512,
      startedAt: "2026-04-11T16:00:00.000Z",
      statusCode: 200,
      url: "http://example.com/health",
    });

    expect(actual).toBe(true);
  });
});

describe("parseSessionSummaries", () => {
  it("returns a valid session list unchanged", () => {
    const payload = [
      {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/health",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/health",
      },
    ];

    const actual = parseSessionSummaries(payload);

    expect(actual).toEqual(payload);
  });

  it("throws when the payload is not an array", () => {
    expect(() => parseSessionSummaries({})).toThrow();
  });
});

describe("parseSessionSummary", () => {
  it("returns a valid session summary unchanged", () => {
    const payload = {
      durationMs: 42,
      finishedAt: "2026-04-11T16:00:01.000Z",
      host: "example.com",
      id: "session-1",
      method: "GET",
      path: "/health",
      protocol: "http",
      scheme: "http",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http",
      sizeBytes: 512,
      startedAt: "2026-04-11T16:00:00.000Z",
      statusCode: 200,
      url: "http://example.com/health",
    };

    const actual = parseSessionSummary(payload);

    expect(actual).toEqual(payload);
  });

  it("throws when the payload is invalid", () => {
    expect(() => parseSessionSummary({ id: "session-1" })).toThrow();
  });
});

describe("isSessionDetail", () => {
  it("returns true for a valid session detail payload", () => {
    const actual = isSessionDetail({
      cookies: [],
      id: "session-1",
      queryParams: [{ name: "lang", value: "en" }],
      rawRequest: "GET /hello HTTP/1.1",
      requestBody: {
        inlineText: '{"hello":"world"}',
        mimeType: "application/json",
        sizeBytes: 17,
      },
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseBody: {
        inlineText: "Hello",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
      timing: {
        requestSendMs: 1,
        responseReadMs: 2,
        totalMs: 3,
        waitingMs: 0,
      },
      rewriteTraces: [],
      scriptTraces: [],
      trailers: [{ name: "x-trailer", value: "test" }],
      h2StreamId: 1,
    });

    expect(actual).toBe(true);
  });

  it("accepts session detail with all trace fields", () => {
    const actual = isSessionDetail({
      id: "test-id",
      cookies: [],
      requestHeaders: [],
      responseHeaders: [],
      queryParams: [],
      summary: {
        durationMs: 10,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "test-id",
        method: "GET",
        path: "/",
        protocol: "http",
        sizeBytes: 0,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/",
      },
      mapTraces: [
        {
          durationMs: 5,
          mode: "remote",
          originalUrl: "https://a.example.com/x",
          outcome: "success",
          ruleId: "m1",
          ruleName: "map-remote",
          sourcePattern: "a.example.com",
          targetValue: "b.example.com",
        },
      ],
      rewriteTraces: [
        {
          durationMs: 3,
          entries: [
            {
              kind: "header",
              key: "X-Custom",
              after: "new-value",
              before: "old-value",
              sequence: 0,
            },
          ],
          outcome: "success",
          rewriteType: "header",
          ruleId: "r1",
          ruleName: "rewrite-header",
          stage: "request",
        },
      ],
      scriptTraces: [
        {
          durationMs: 10,
          entries: [{ kind: "log", level: "info", message: "script ran", sequence: 0 }],
          outcome: "success",
          ruleId: "s1",
          stage: "request",
        },
      ],
      throttleTraces: [
        {
          bodyBytes: 1024,
          delayMs: 50,
          latencyMs: 100,
          outcome: "applied",
          profileId: "p1",
          profileName: "Slow 3G",
          sequence: 0,
          stage: "request",
          transferDelayMs: 200,
        },
      ],
      trailers: [{ name: "x-trailer", value: "test" }],
      h2StreamId: 42,
      timingSource: "proxy",
    });

    expect(actual).toBe(true);
  });

  it("rejects session detail with invalid rewriteTraces", () => {
    const actual = isSessionDetail({
      id: "test-id",
      cookies: [],
      requestHeaders: [],
      responseHeaders: [],
      queryParams: [],
      summary: {
        durationMs: 10,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "test-id",
        method: "GET",
        path: "/",
        protocol: "http",
        sizeBytes: 0,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/",
      },
      rewriteTraces: "not-an-array",
    });

    expect(actual).toBe(false);
  });
});

describe("parseSessionDetail", () => {
  it("returns a valid session detail payload unchanged", () => {
    const payload = {
      cookies: [],
      id: "session-1",
      queryParams: [],
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
    };

    const actual = parseSessionDetail(payload);

    expect(actual).toEqual(payload);
  });

  it("normalizes nullable optional fields from the Tauri command layer", () => {
    const actual = parseSessionDetail({
      cookies: [],
      id: "session-1",
      queryParams: [],
      rawRequest: null,
      rawResponse: null,
      requestBody: {
        base64Text: null,
        encoding: null,
        inlineText: "Hello",
        mimeType: "text/plain",
        sizeBytes: 5,
        truncated: null,
      },
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseBody: null,
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      serverIp: null,
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
      timing: {
        connectMs: null,
        requestSendMs: 1,
        responseReadMs: 2,
        tlsMs: null,
        totalMs: 3,
        waitingMs: null,
      },
    });

    expect(actual).toEqual({
      cookies: [],
      id: "session-1",
      queryParams: [],
      requestBody: {
        inlineText: "Hello",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
      timing: {
        requestSendMs: 1,
        responseReadMs: 2,
        totalMs: 3,
      },
    });
  });

  it("normalizes legacy snake_case timing fields from older command payloads", () => {
    const actual = parseSessionDetail({
      cookies: [],
      id: "session-1",
      queryParams: [],
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
      timing: {
        request_send_ms: 1,
        response_read_ms: 2,
        total_ms: 3,
        waiting_ms: 0,
      },
    });

    expect(actual.timing).toEqual({
      requestSendMs: 1,
      responseReadMs: 2,
      totalMs: 3,
      waitingMs: 0,
    });
  });

  it("preserves rewriteTraces, scriptTraces, trailers, and h2StreamId", () => {
    const payload = {
      cookies: [],
      id: "session-1",
      queryParams: [],
      requestHeaders: [{ name: "Host", value: "example.com" }],
      responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
      rewriteTraces: [
        {
          durationMs: 3,
          entries: [
            {
              kind: "header",
              key: "X-Custom",
              after: "new-value",
              before: "old-value",
              sequence: 0,
            },
          ],
          outcome: "success",
          rewriteType: "header",
          ruleId: "r1",
          ruleName: "rewrite-header",
          stage: "request",
        },
      ],
      scriptTraces: [
        {
          durationMs: 10,
          entries: [{ kind: "log", level: "info", message: "script ran", sequence: 0 }],
          outcome: "success",
          ruleId: "s1",
          stage: "request",
        },
      ],
      trailers: [{ name: "x-trailer", value: "test" }],
      h2StreamId: 7,
      viaUpstreamProxy: true,
    };

    const parsed = parseSessionDetail(payload);

    expect(parsed.rewriteTraces).toEqual(payload.rewriteTraces);
    expect(parsed.scriptTraces).toEqual(payload.scriptTraces);
    expect(parsed.trailers).toEqual(payload.trailers);
    expect(parsed.h2StreamId).toBe(payload.h2StreamId);
    expect(parsed.viaUpstreamProxy).toBe(true);
  });

  it("distinguishes a direct route from an unknown one", () => {
    const base = {
      cookies: [],
      id: "session-1",
      queryParams: [],
      requestHeaders: [],
      responseHeaders: [],
      summary: {
        durationMs: 42,
        finishedAt: "2026-04-11T16:00:01.000Z",
        host: "example.com",
        id: "session-1",
        method: "GET",
        path: "/hello",
        protocol: "http",
        sizeBytes: 512,
        startedAt: "2026-04-11T16:00:00.000Z",
        statusCode: 200,
        url: "http://example.com/hello",
      },
    };

    // An explicit `false` means "dialed directly" and must survive parsing —
    // collapsing it to undefined would render as "unknown" in the inspector.
    expect(parseSessionDetail({ ...base, viaUpstreamProxy: false }).viaUpstreamProxy).toBe(false);
    // Absent/null means the routing decision is genuinely unknown.
    expect(parseSessionDetail(base).viaUpstreamProxy).toBeUndefined();
    expect(
      parseSessionDetail({ ...base, viaUpstreamProxy: null }).viaUpstreamProxy,
    ).toBeUndefined();
  });

  it("throws when the payload is invalid", () => {
    expect(() => parseSessionDetail({ id: "session-1" })).toThrow();
  });
});

describe("parseRemoveCertificateTrustOutput", () => {
  it("parses a valid output with status and per-store report", () => {
    const payload = {
      status: { certPath: null, fingerprint: null, trusted: false, platform: "macos" },
      trustRemoval: {
        attempted: ["macos.userDomain", "macos.systemDomain"],
        succeeded: ["macos.userDomain"],
        failed: [{ store: "macos.systemDomain", error: "access denied" }],
      },
    };

    const parsed = parseRemoveCertificateTrustOutput(payload);

    expect(parsed.status.trusted).toBe(false);
    expect(parsed.status.platform).toBe("macos");
    expect(parsed.trustRemoval.succeeded).toEqual(["macos.userDomain"]);
    expect(parsed.trustRemoval.failed).toEqual([
      { store: "macos.systemDomain", error: "access denied" },
    ]);
  });

  it("throws when the trust report shape is invalid", () => {
    const payload = {
      status: { trusted: false, platform: "macos" },
      trustRemoval: { attempted: "macos.userDomain", succeeded: [], failed: [] },
    };

    expect(() => parseRemoveCertificateTrustOutput(payload)).toThrow();
  });

  it("normalizes a null systemProxyHandbackError away and keeps a string one", () => {
    const base = {
      status: { trusted: false, platform: "macos" },
      trustRemoval: { attempted: [], succeeded: [], failed: [] },
    };

    expect(
      parseRemoveCertificateTrustOutput({ ...base, systemProxyHandbackError: null }),
    ).not.toHaveProperty("systemProxyHandbackError");
    expect(
      parseRemoveCertificateTrustOutput({ ...base, systemProxyHandbackError: "restore failed" })
        .systemProxyHandbackError,
    ).toBe("restore failed");
    // A non-string handback error must be rejected, not coerced.
    expect(() =>
      parseRemoveCertificateTrustOutput({ ...base, systemProxyHandbackError: 42 }),
    ).toThrow();
  });
});

describe("parseWsMessages", () => {
  function makeWsMessage(id: string) {
    return {
      id,
      sessionId: "session-1",
      direction: "clientToServer",
      timestamp: "2026-08-23T10:00:00.000Z",
      opcode: "text",
      payloadText: "hello",
      payloadSize: 5,
      fin: true,
      truncated: false,
    };
  }

  it("returns a valid message list unchanged", () => {
    const payload = [makeWsMessage("ws-1"), makeWsMessage("ws-2")];
    expect(parseWsMessages(payload)).toEqual(payload);
  });

  it("accepts an empty list", () => {
    expect(parseWsMessages([])).toEqual([]);
  });

  it("keeps the generic app error when the payload is not an array", () => {
    try {
      parseWsMessages({ id: "ws-1" });
      throw new Error("expected parseWsMessages to throw");
    } catch (error) {
      const actual = coerceAppError(error);
      expect(actual.code).toBe("UNKNOWN_ERROR");
      expect(actual.message).toBe("An unexpected error occurred.");
      expect(actual.details).toEqual({ receivedType: "object" });
    }
  });

  // P2 4.3-1: a failing batch must surface which entries were invalid instead
  // of collapsing into "An unexpected error occurred.".
  it("throws a structured INVALID_WS_MESSAGES error naming the bad indexes", () => {
    let thrown: unknown;
    try {
      parseWsMessages([makeWsMessage("ws-1"), { id: "broken" }, makeWsMessage("ws-3"), null]);
      throw new Error("expected parseWsMessages to throw");
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    const actual = thrown as { code: string; message: string; details?: Record<string, unknown> };
    expect(actual.code).toBe(INVALID_WS_MESSAGES);
    expect(actual.message).toContain("2 of 4");
    expect(actual.message).toContain("[1, 3]");
    expect(actual.details?.totalCount).toBe(4);
    expect(actual.details?.invalidCount).toBe(2);
    expect(actual.details?.invalidIndexes).toEqual([1, 3]);
    expect(actual.details?.samples).toEqual(['[1] {"id":"broken"}', "[3] null"]);
  });

  it("bounds the reported samples for large failing batches", () => {
    const payload = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? makeWsMessage(`ws-${index}`) : { broken: index },
    );

    try {
      parseWsMessages(payload);
      throw new Error("expected parseWsMessages to throw");
    } catch (error) {
      const actual = error as { message: string; details?: Record<string, unknown> };
      expect(actual.details?.invalidCount).toBe(10);
      expect((actual.details?.invalidIndexes as number[]).length).toBe(10);
      expect((actual.details?.samples as string[]).length).toBe(5);
      expect(actual.message).toContain(", ...]");
    }
  });
});

describe("upstream proxy contract", () => {
  const validSettings = {
    enabled: true,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 7891,
    username: "alice",
    password: "s3cret",
    bypass: ["localhost", "*.internal"],
  };

  it("accepts every supported protocol and rejects others", () => {
    expect(isUpstreamProxyProtocol("http")).toBe(true);
    expect(isUpstreamProxyProtocol("https")).toBe(true);
    expect(isUpstreamProxyProtocol("socks5")).toBe(true);
    // socks4 is deliberately unsupported.
    expect(isUpstreamProxyProtocol("socks4")).toBe(false);
    expect(isUpstreamProxyProtocol("")).toBe(false);
    expect(isUpstreamProxyProtocol(undefined)).toBe(false);
  });

  it("validates a complete settings object", () => {
    expect(isUpstreamProxySettings(validSettings)).toBe(true);
  });

  it("accepts settings without credentials", () => {
    expect(
      isUpstreamProxySettings({
        enabled: false,
        protocol: "http",
        host: "127.0.0.1",
        port: 7890,
        bypass: [],
      }),
    ).toBe(true);
  });

  it("rejects settings with a malformed protocol or bypass list", () => {
    expect(isUpstreamProxySettings({ ...validSettings, protocol: "socks4" })).toBe(false);
    expect(isUpstreamProxySettings({ ...validSettings, bypass: "localhost" })).toBe(false);
    expect(isUpstreamProxySettings({ ...validSettings, bypass: [1, 2] })).toBe(false);
    expect(isUpstreamProxySettings({ ...validSettings, port: "7890" })).toBe(false);
    expect(isUpstreamProxySettings(null)).toBe(false);
  });

  it("parses a successful probe result", () => {
    const parsed = parseUpstreamProxyProbeResult({
      success: true,
      elapsedMs: 42,
      probeTarget: "www.apple.com:443",
      error: null,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.elapsedMs).toBe(42);
    expect(parsed.probeTarget).toBe("www.apple.com:443");
    // A null error is dropped rather than surfaced as a falsy message.
    expect(parsed.error).toBeUndefined();
  });

  it("parses a failed probe result and keeps the error", () => {
    const parsed = parseUpstreamProxyProbeResult({
      success: false,
      elapsedMs: 7,
      probeTarget: "www.apple.com:443",
      error: "connection refused",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("connection refused");
  });

  it("throws when the probe payload is invalid", () => {
    expect(() => parseUpstreamProxyProbeResult({ success: true })).toThrow();
  });
});

describe("SslProxyingSettings", () => {
  it("validates a complete settings object", () => {
    expect(isSslProxyingSettings({ include: ["*.example.com"], exclude: ["*.pinned.com"] })).toBe(
      true,
    );
  });

  it("accepts two empty lists, which means intercept everything", () => {
    expect(isSslProxyingSettings({ include: [], exclude: [] })).toBe(true);
  });

  it("rejects malformed or missing pattern lists", () => {
    expect(isSslProxyingSettings({ include: ["ok"] })).toBe(false);
    expect(isSslProxyingSettings({ exclude: ["ok"] })).toBe(false);
    expect(isSslProxyingSettings({ include: "*.example.com", exclude: [] })).toBe(false);
    expect(isSslProxyingSettings({ include: [], exclude: [1, 2] })).toBe(false);
    expect(isSslProxyingSettings(null)).toBe(false);
    expect(isSslProxyingSettings(undefined)).toBe(false);
  });

  it("parses the recommended exclusion list and rejects non-string payloads", () => {
    expect(parseSslProxyingExclusions(["*.tiktokv.com", "*.icloud.com"])).toEqual([
      "*.tiktokv.com",
      "*.icloud.com",
    ]);
    expect(parseSslProxyingExclusions([])).toEqual([]);
    expect(() => parseSslProxyingExclusions([1, 2])).toThrow();
    expect(() => parseSslProxyingExclusions("*.example.com")).toThrow();
  });
});
