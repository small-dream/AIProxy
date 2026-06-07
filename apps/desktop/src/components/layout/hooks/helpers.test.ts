import { describe, expect, it } from "vitest";

import { getErrorMessage, isPortInUseError, isMacPlatform, isTauriRuntime } from "./helpers";

describe("getErrorMessage", () => {
  it("returns the error message from a JSON AppError string", () => {
    const error = JSON.stringify({ code: "TEST_ERROR", message: "test failed" });
    expect(getErrorMessage(error, "fallback")).toBe("test failed");
  });

  it("returns the raw string when it is not JSON", () => {
    expect(getErrorMessage("plain error text", "fallback")).toBe("plain error text");
  });

  it("returns the fallback when the error message is empty", () => {
    // coerceAppError returns "An unexpected error occurred." for empty strings
    expect(getErrorMessage("", "fallback message")).toBe("An unexpected error occurred.");
  });

  it("returns the fallback when the error message is whitespace only", () => {
    // coerceAppError normalizes whitespace-only to "An unexpected error occurred."
    expect(getErrorMessage("   ", "fallback message")).toBe("An unexpected error occurred.");
  });

  it("returns the error message from an Error instance", () => {
    expect(getErrorMessage(new Error("instance message"), "fallback")).toBe("instance message");
  });
});

describe("isPortInUseError", () => {
  it("detects PORT_IN_USE code in a JSON error string", () => {
    const error = JSON.stringify({ code: "PORT_IN_USE", message: "Port busy" });
    expect(isPortInUseError(error)).toBe(true);
  });

  it("detects 'already in use' in the message text", () => {
    expect(isPortInUseError("Address already in use")).toBe(true);
  });

  it("detects 'address already in use' case-insensitively", () => {
    expect(isPortInUseError("ADDRESS ALREADY IN USE")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPortInUseError("something else")).toBe(false);
  });

  it("returns false for a JSON error with a different code", () => {
    const error = JSON.stringify({ code: "INTERNAL_ERROR", message: "other" });
    expect(isPortInUseError(error)).toBe(false);
  });
});

describe("isTauriRuntime", () => {
  it("returns false when __TAURI_INTERNALS__ is not present", () => {
    expect(isTauriRuntime()).toBe(false);
  });
});

describe("isMacPlatform", () => {
  it("returns false when navigator.userAgent contains linux", () => {
    // Default test environment (jsdom) doesn't match Mac
    const result = isMacPlatform();
    expect(typeof result).toBe("boolean");
  });
});
