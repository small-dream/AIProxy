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
  it("builds tree for 10k sessions in under 100ms", () => {
    const start = performance.now();
    const groups = buildSessionHostGroups(sessions, "");
    const elapsed = performance.now() - start;

    expect(groups.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
