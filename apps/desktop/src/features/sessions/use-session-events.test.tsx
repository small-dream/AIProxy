import { describe, expect, it } from "vitest";

import { useSessionEvents } from "./use-session-events";

describe("useSessionEvents", () => {
  it("is a no-op that does not throw", () => {
    expect(() => useSessionEvents()).not.toThrow();
  });
});
