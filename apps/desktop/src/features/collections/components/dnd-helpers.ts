import type { ApiCollection } from "@aiproxy/shared-types";

export type DragNodeKind = "folder" | "item";
export type DropPosition = "before" | "after" | "into";

export type ComputeDropIntentArgs = {
  activeKind: DragNodeKind;
  overKind: DragNodeKind;
  overTop: number;
  overHeight: number;
  cursorY: number;
  overIsExpanded: boolean;
  overHasChildren: boolean;
};

export function computeDropIntent({
  activeKind,
  overKind,
  overTop,
  overHeight,
  cursorY,
  overIsExpanded,
  overHasChildren,
}: ComputeDropIntentArgs): DropPosition | null {
  if (activeKind === "folder" && overKind === "item") return null;
  if (overHeight <= 0) return null;

  const offset = cursorY - overTop;
  const ratio = Math.max(0, Math.min(1, offset / overHeight));

  if (overKind === "item") {
    return ratio < 0.5 ? "before" : "after";
  }

  if (activeKind === "item") {
    return "into";
  }

  if (overIsExpanded && !overHasChildren) {
    return "into";
  }

  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "into";
}

export function isFolderCycleViolation(
  activeId: string,
  targetParentId: string | null,
  collections: ApiCollection[],
): boolean {
  if (targetParentId === null) return false;
  if (targetParentId === activeId) return true;
  const parentLookup = new Map(collections.map((c) => [c.id, c.parentId]));
  let cur: string | null = targetParentId;
  const visited = new Set<string>();
  while (cur) {
    if (cur === activeId) return true;
    if (visited.has(cur)) return false;
    visited.add(cur);
    cur = parentLookup.get(cur) ?? null;
  }
  return false;
}
