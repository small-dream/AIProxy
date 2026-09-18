import { act, renderHook } from "@testing-library/react";
import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiCollection } from "@aiproxy/shared-types";

import type { CollectionEditorState } from "@/features/collections/collection-editor.store";
import { buildCollectionTree } from "@/features/collections/use-collections";

import { useCollectionTree, type UseCollectionTreeParams } from "./use-collection-tree";

// Spring-load: hovering a collapsed folder mid-drag schedules a 500ms timer
// that auto-expands it. Unmounting the tree with that timer pending must
// clear it, or it fires handleToggleExpand against an unmounted tree.

function makeCollection(id: string): ApiCollection {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    description: "",
    id,
    name: id,
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

function makeParams(collections: ApiCollection[]): UseCollectionTreeParams {
  const mutation = { mutate: vi.fn() };
  return {
    collections,
    items: [],
    tree: buildCollectionTree(collections),
    selectedCollectionId: null,
    selectedItemId: null,
    collectionFilter: "",
    upsertCollection: mutation as unknown as UseCollectionTreeParams["upsertCollection"],
    deleteCollection: mutation as unknown as UseCollectionTreeParams["deleteCollection"],
    moveCollection: mutation as unknown as UseCollectionTreeParams["moveCollection"],
    upsertItem: mutation as unknown as UseCollectionTreeParams["upsertItem"],
    deleteItem: mutation as unknown as UseCollectionTreeParams["deleteItem"],
    moveItem: mutation as unknown as UseCollectionTreeParams["moveItem"],
    editor: {
      loadFromItem: vi.fn(),
      reset: vi.fn(),
    } as unknown as CollectionEditorState,
    setSelectedCollectionId: vi.fn(),
    setSelectedItemId: vi.fn(),
    t: (key) => key,
  };
}

function dragStart(folderId: string): DragStartEvent {
  return { active: { id: `folder:${folderId}` } } as unknown as DragStartEvent;
}

function dragOverFolder(folderId: string): DragOverEvent {
  return {
    active: { id: "folder:col-a" },
    over: { id: `folder:${folderId}`, rect: { top: 100, height: 40 } },
  } as unknown as DragOverEvent;
}

// Arms a spring-load timer: drag folder col-a over the collapsed col-b with
// the cursor in the middle ("into") zone.
function armSpringLoad(result: { current: ReturnType<typeof useCollectionTree> }) {
  act(() => {
    result.current.handleToggleExpand("col-b", false);
  });
  act(() => {
    result.current.handleDragStart(dragStart("col-a"));
  });
  act(() => {
    // Cursor at y=120 → ratio 0.5 inside over rect (top 100, height 40).
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 120 }));
  });
  act(() => {
    result.current.handleDragOver(dragOverFolder("col-b"));
  });
}

describe("useCollectionTree spring-load timer cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expands the collapsed folder after 500ms while mounted (control)", () => {
    const collections = [makeCollection("col-a"), makeCollection("col-b")];
    const { result } = renderHook(() => useCollectionTree(makeParams(collections)));

    armSpringLoad(result);
    expect(result.current.isFolderExpanded("col-b")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isFolderExpanded("col-b")).toBe(true);
  });

  it("clears the pending spring-load timer on unmount", () => {
    const collections = [makeCollection("col-a"), makeCollection("col-b")];
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useCollectionTree(makeParams(collections)));

    armSpringLoad(result);
    expect(result.current.isFolderExpanded("col-b")).toBe(false);

    unmount();

    // The unmount cleanup must have cleared the pending expand timer.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
