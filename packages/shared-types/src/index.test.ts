import { describe, expect, it } from "vitest";

import {
  coerceAppError,
  createDefaultProxyStatus,
  DEFAULT_PROXY_PORT,
  isAppError,
  isProxyStatus,
  isSessionSummary,
  normalizeStartProxyInput,
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
      enableSsl: false,
      port: DEFAULT_PROXY_PORT,
      workspaceId: "default-workspace",
    });
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
