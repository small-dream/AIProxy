import { describe, expect, it } from "vitest";

import {
  coerceAppError,
  createDefaultProxyStatus,
  createMockComposeSessionDetail,
  DEFAULT_PROXY_PORT,
  isAppError,
  isSessionDetail,
  isProxyStatus,
  isSessionSummary,
  normalizeStartProxyInput,
  parseSessionDetail,
  parseSessionSummary,
  parseSessionSummaries,
  parseProxyStatus,
} from "./index";

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
      enableSsl: true,
      port: DEFAULT_PROXY_PORT,
      workspaceId: "default-workspace",
    });
  });
});

describe("createMockComposeSessionDetail", () => {
  it("uses one id for the detail and summary", () => {
    const detail = createMockComposeSessionDetail({
      body: "{\"ok\":true}",
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
        inlineText: "{\"hello\":\"world\"}",
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
    });

    expect(actual).toBe(true);
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

  it("throws when the payload is invalid", () => {
    expect(() => parseSessionDetail({ id: "session-1" })).toThrow();
  });
});
