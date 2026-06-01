import { describe, expect, it } from "vitest";

import { isCapturedSessionNotFoundError } from "./sessions";

describe("isCapturedSessionNotFoundError", () => {
  it("detects structured session not found errors", () => {
    expect(isCapturedSessionNotFoundError({
      code: "SESSION_NOT_FOUND",
      message: "Captured session session-1 was not found.",
    })).toBe(true);
  });

  it("does not infer session not found from unstructured strings", () => {
    expect(isCapturedSessionNotFoundError("captured session session-1 was not found")).toBe(false);
  });
});
