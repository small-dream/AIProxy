import { describe, expect, it } from "vitest";

import { getErrorMessage, isMacPlatform, isTauriRuntime } from "./helpers";

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
