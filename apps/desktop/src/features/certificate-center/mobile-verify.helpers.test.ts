import { describe, expect, it } from "vitest";

import { computeMobileVerifyState } from "./mobile-verify.helpers";

const BASE = {
  baselineCount: 5,
  baselineStartedAtMs: 1_000,
  timeoutMs: 120_000,
} as const;

describe("computeMobileVerifyState", () => {
  it("is idle when no run is armed", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: false,
        currentCount: 9,
        nowMs: 1_000,
      }),
    ).toBe("idle");
  });

  it("is listening while armed without new sessions and inside the window", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: true,
        currentCount: 5,
        nowMs: 60_000,
      }),
    ).toBe("listening");
  });

  it("is success once any new session arrives", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: true,
        currentCount: 6,
        nowMs: 5_000,
      }),
    ).toBe("success");
  });

  it("is timeout when the window elapses with no new sessions", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: true,
        currentCount: 5,
        nowMs: 1_000 + 120_000,
      }),
    ).toBe("timeout");
  });

  it("success wins over timeout at the boundary", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: true,
        currentCount: 7,
        nowMs: 1_000 + 130_000,
      }),
    ).toBe("success");
  });

  it("treats a missing baseline timestamp as still listening (never times out)", () => {
    expect(
      computeMobileVerifyState({
        ...BASE,
        armed: true,
        baselineStartedAtMs: null,
        currentCount: 5,
        nowMs: 1_000 + 999_999,
      }),
    ).toBe("listening");
  });
});
