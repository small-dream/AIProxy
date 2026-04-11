import { describe, expect, it } from "vitest";

import {
  coerceAppError,
  createDefaultProxyStatus,
  DEFAULT_PROXY_PORT,
  isAppError,
  isProxyStatus,
  normalizeStartProxyInput,
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
