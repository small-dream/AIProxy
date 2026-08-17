import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildSessionHostGroups } from "./session-explorer.helpers";
import type { SessionSummary } from "@aiproxy/shared-types";

const fixturesDir = join(__dirname, "../../../../../fixtures/stress");
const sessions: SessionSummary[] = JSON.parse(
  readFileSync(join(fixturesDir, "10k-sessions.json"), "utf-8"),
);

describe("buildSessionHostGroups stress", () => {
  it("builds tree for 10k sessions in under 200ms (best of 3)", () => {
    // Best-of-3 absorbs JIT warm-up and runner scheduling jitter on shared CI
    // machines; the 200ms ceiling still catches order-of-magnitude regressions
    // (local baseline is well under 20ms, CI observed ~110ms once stabilized).
    let elapsed = Number.POSITIVE_INFINITY;
    let groupsLength = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const start = performance.now();
      const groups = buildSessionHostGroups(sessions, "");
      elapsed = Math.min(elapsed, performance.now() - start);
      groupsLength = groups.length;
    }

    expect(groupsLength).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});
