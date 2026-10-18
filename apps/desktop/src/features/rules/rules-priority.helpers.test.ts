import { describe, expect, it } from "vitest";

import {
  applyOrderedIdsWithinList,
  computeReorderedPriorities,
  DEFAULT_RULE_PRIORITY,
  moveRuleInOrder,
  nextAppendedPriority,
  resolveNewRulePriority,
} from "./rules-priority.helpers";

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

describe("nextAppendedPriority", () => {
  it("starts an empty list at the historical default", () => {
    expect(nextAppendedPriority([])).toBe(DEFAULT_RULE_PRIORITY);
  });

  it("appends one step below the current lowest priority", () => {
    expect(nextAppendedPriority([100, 50, 20])).toBe(10);
    expect(nextAppendedPriority([20, 10])).toBe(0);
  });
});

describe("resolveNewRulePriority", () => {
  const rule = (id: string, priority: number) => ({ id, priority });

  it("derives the append priority from the list at save time, not creation time", () => {
    // The draft was handed 100 on creation; the list has since been renumbered
    // by a reorder, so the persisted value must follow the CURRENT minimum.
    expect(resolveNewRulePriority(rule("new", 100), [rule("a", 20), rule("b", 10)], 100)).toBe(0);
  });

  it("keeps the append priority stable when the list did not change", () => {
    // 90 is what the editor handed the draft (min 100 - 10); recomputing
    // against the same list must not change it.
    expect(resolveNewRulePriority(rule("new", 90), [rule("a", 200), rule("b", 100)], 90)).toBe(90);
  });

  it("respects a priority the user edited in Advanced", () => {
    expect(resolveNewRulePriority(rule("new", 999), [rule("a", 200), rule("b", 100)], 100)).toBe(
      999,
    );
  });

  it("never rewrites the priority of a rule that already exists", () => {
    expect(resolveNewRulePriority(rule("a", 200), [rule("a", 200), rule("b", 100)], 100)).toBe(200);
  });

  it("keeps the draft value when no auto-assigned priority was recorded", () => {
    expect(resolveNewRulePriority(rule("new", 100), [rule("a", 200)], null)).toBe(100);
  });
});

describe("moveRuleInOrder", () => {
  it("moves a rule one slot up or down", () => {
    expect(moveRuleInOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveRuleInOrder(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("returns null at the boundaries", () => {
    expect(moveRuleInOrder(["a", "b"], "a", -1)).toBeNull();
    expect(moveRuleInOrder(["a", "b"], "b", 1)).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(moveRuleInOrder(["a", "b"], "zzz", 1)).toBeNull();
  });
});

describe("applyOrderedIdsWithinList", () => {
  const rule = (id: string) => ({ id });

  it("applies the new order across the whole list when nothing is filtered", () => {
    const all = [rule("a"), rule("b"), rule("c")];
    expect(applyOrderedIdsWithinList(all, ["c", "a", "b"])).toEqual([
      rule("c"),
      rule("a"),
      rule("b"),
    ]);
  });

  it("keeps items hidden by a search filter in their slots", () => {
    // Visible: a and c (b is filtered out); user swaps them.
    const all = [rule("a"), rule("b"), rule("c")];
    expect(applyOrderedIdsWithinList(all, ["c", "a"])).toEqual([rule("c"), rule("b"), rule("a")]);
  });

  it("is a stable no-op when the order is unchanged", () => {
    const all = [rule("a"), rule("b")];
    expect(applyOrderedIdsWithinList(all, ["a", "b"])).toEqual(all);
  });
});
