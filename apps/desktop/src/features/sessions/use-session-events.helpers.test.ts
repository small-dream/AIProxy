import { describe, expect, it } from "vitest";

import { REMOVED_SESSION_TOMBSTONE_LIMIT, rememberRemovedSessionIds } from "./use-session-events";

describe("rememberRemovedSessionIds", () => {
  it("records ids and evicts the oldest once the cap is exceeded", () => {
    const tombstones = new Set<string>();
    const firstBatch = Array.from({ length: REMOVED_SESSION_TOMBSTONE_LIMIT }, (_, i) => `id-${i}`);
    rememberRemovedSessionIds(tombstones, firstBatch);
    expect(tombstones.size).toBe(REMOVED_SESSION_TOMBSTONE_LIMIT);

    // Adding one more evicts the OLDEST tombstone (insertion order), not the
    // new one.
    rememberRemovedSessionIds(tombstones, ["fresh-id"]);
    expect(tombstones.size).toBe(REMOVED_SESSION_TOMBSTONE_LIMIT);
    expect(tombstones.has("id-0")).toBe(false);
    expect(tombstones.has("id-1")).toBe(true);
    expect(tombstones.has("fresh-id")).toBe(true);
  });

  it("re-adding an existing id does not grow the set", () => {
    const tombstones = new Set<string>(["a", "b"]);
    rememberRemovedSessionIds(tombstones, ["a"]);
    expect(tombstones.size).toBe(2);
  });

  it("handles an empty batch", () => {
    const tombstones = new Set<string>(["a"]);
    rememberRemovedSessionIds(tombstones, []);
    expect(tombstones.size).toBe(1);
  });
});
