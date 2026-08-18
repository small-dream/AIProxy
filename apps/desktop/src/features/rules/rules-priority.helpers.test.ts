import { describe, expect, it } from "vitest";

import { computeReorderedPriorities } from "./rules-priority.helpers";

describe("computeReorderedPriorities", () => {
  it("renumbers top-first with a step of 10", () => {
    const priorities = new Map([
      ["a", 30],
      ["b", 20],
      ["c", 10],
    ]);

    // Move c to the top.
    expect(computeReorderedPriorities(["c", "a", "b"], priorities)).toEqual([
      { id: "c", priority: 30 },
      { id: "a", priority: 20 },
      { id: "b", priority: 10 },
    ]);
  });

  it("only returns rows whose priority changed", () => {
    const priorities = new Map([
      ["a", 30],
      ["b", 20],
      ["c", 10],
    ]);

    // Reordering a/b keeps their computed values identical to current.
    expect(computeReorderedPriorities(["a", "b", "c"], priorities)).toEqual([]);
  });

  it("handles the boundary where the last row already has priority 10", () => {
    const priorities = new Map([
      ["a", 20],
      ["b", 10],
    ]);
    expect(computeReorderedPriorities(["b", "a"], priorities)).toEqual([
      { id: "b", priority: 20 },
      { id: "a", priority: 10 },
    ]);
  });
});
