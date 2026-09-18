import { describe, expect, it } from "vitest";

import { shouldFallbackToLocalStore } from "./runtime";

describe("shouldFallbackToLocalStore", () => {
  it("falls back for the exact Tauri unregistered-command rejection", () => {
    expect(shouldFallbackToLocalStore("Command save_rewrite_rule not found")).toBe(true);
    expect(shouldFallbackToLocalStore(new Error("Command list_rewrite_rules not found"))).toBe(
      true,
    );
    expect(
      shouldFallbackToLocalStore({
        code: "UNKNOWN_ERROR",
        message: "Command delete_rule not found",
      }),
    ).toBe(true);
  });

  it("does not fall back for backend entity not-found errors", () => {
    expect(shouldFallbackToLocalStore("workspace not found: abc")).toBe(false);
    expect(shouldFallbackToLocalStore("rewrite rule not found: rule-1")).toBe(false);
    expect(
      shouldFallbackToLocalStore({
        code: "NOT_FOUND",
        message: "workspace not found: abc",
      }),
    ).toBe(false);
  });

  it("does not fall back for other command-related errors", () => {
    expect(
      shouldFallbackToLocalStore("myplugin.unknown-command not allowed. Command not found"),
    ).toBe(false);
    expect(shouldFallbackToLocalStore("failed to invoke save_rewrite_rule")).toBe(false);
    expect(shouldFallbackToLocalStore("some command is not found in the config")).toBe(false);
    expect(shouldFallbackToLocalStore(new Error("network timeout"))).toBe(false);
  });
});
