import { describe, expect, it } from "vitest";
import type { ApiCollection } from "@aiproxy/shared-types";

import { computeDropIntent, isFolderCycleViolation } from "./dnd-helpers";

function baseArgs(overrides: Partial<Parameters<typeof computeDropIntent>[0]> = {}) {
  return {
    activeKind: "folder" as const,
    overKind: "folder" as const,
    overTop: 0,
    overHeight: 40,
    cursorY: 20,
    overIsExpanded: false,
    overHasChildren: true,
    ...overrides,
  };
}

describe("computeDropIntent", () => {
  it("folder over folder: top 25% is before", () => {
    expect(computeDropIntent(baseArgs({ cursorY: 5 }))).toBe("before");
    expect(computeDropIntent(baseArgs({ cursorY: 9 }))).toBe("before");
  });

  it("folder over folder: middle 50% is into", () => {
    expect(computeDropIntent(baseArgs({ cursorY: 12 }))).toBe("into");
    expect(computeDropIntent(baseArgs({ cursorY: 28 }))).toBe("into");
  });

  it("folder over folder: bottom 25% is after", () => {
    expect(computeDropIntent(baseArgs({ cursorY: 32 }))).toBe("after");
    expect(computeDropIntent(baseArgs({ cursorY: 39 }))).toBe("after");
  });

  it("empty expanded folder: entire row is into", () => {
    const args = baseArgs({ overIsExpanded: true, overHasChildren: false });
    expect(computeDropIntent({ ...args, cursorY: 1 })).toBe("into");
    expect(computeDropIntent({ ...args, cursorY: 20 })).toBe("into");
    expect(computeDropIntent({ ...args, cursorY: 38 })).toBe("into");
  });

  it("item over item: 50/50 split, never into", () => {
    const args = baseArgs({ activeKind: "item", overKind: "item" });
    expect(computeDropIntent({ ...args, cursorY: 10 })).toBe("before");
    expect(computeDropIntent({ ...args, cursorY: 19 })).toBe("before");
    expect(computeDropIntent({ ...args, cursorY: 22 })).toBe("after");
    expect(computeDropIntent({ ...args, cursorY: 38 })).toBe("after");
  });

  it("item over folder: always into", () => {
    const args = baseArgs({ activeKind: "item", overKind: "folder" });
    expect(computeDropIntent({ ...args, cursorY: 1 })).toBe("into");
    expect(computeDropIntent({ ...args, cursorY: 20 })).toBe("into");
    expect(computeDropIntent({ ...args, cursorY: 38 })).toBe("into");
  });

  it("folder over item: invalid (null)", () => {
    const args = baseArgs({ activeKind: "folder", overKind: "item" });
    expect(computeDropIntent({ ...args, cursorY: 10 })).toBeNull();
    expect(computeDropIntent({ ...args, cursorY: 30 })).toBeNull();
  });

  it("zero-height target returns null", () => {
    const args = baseArgs({ overHeight: 0 });
    expect(computeDropIntent(args)).toBeNull();
  });
});

describe("isFolderCycleViolation", () => {
  function fixture(): ApiCollection[] {
    const base = (id: string, parentId: string | null): ApiCollection => ({
      id,
      parentId,
      name: id,
      description: "",
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    });
    return [
      base("root1", null),
      base("root2", null),
      base("c1", "root1"),
      base("c2", "c1"),
      base("c3", "c2"),
    ];
  }

  it("dropping at root is never a cycle", () => {
    expect(isFolderCycleViolation("c1", null, fixture())).toBe(false);
  });

  it("rejects dropping a folder onto itself", () => {
    expect(isFolderCycleViolation("c1", "c1", fixture())).toBe(true);
  });

  it("rejects dropping a folder into its own descendant", () => {
    expect(isFolderCycleViolation("root1", "c3", fixture())).toBe(true);
    expect(isFolderCycleViolation("c1", "c3", fixture())).toBe(true);
  });

  it("allows dropping into a sibling subtree", () => {
    expect(isFolderCycleViolation("c1", "root2", fixture())).toBe(false);
  });

  it("allows dropping a leaf folder into a non-descendant", () => {
    expect(isFolderCycleViolation("c3", "root2", fixture())).toBe(false);
  });
});
