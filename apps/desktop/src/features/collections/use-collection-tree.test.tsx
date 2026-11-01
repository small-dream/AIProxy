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

function makeParams(collections: ApiCollection[]) {
  const upsertCollection = { mutate: vi.fn() };
  const deleteMutation = { mutate: vi.fn() };
  const upsertItem = { mutate: vi.fn() };
  const params: UseCollectionTreeParams = {
    collections,
    items: [],
    tree: buildCollectionTree(collections),
    selectedCollectionId: null,
    selectedItemId: null,
    collectionFilter: "",
    upsertCollection: upsertCollection as unknown as UseCollectionTreeParams["upsertCollection"],
    deleteCollection: deleteMutation as unknown as UseCollectionTreeParams["deleteCollection"],
    moveCollection: deleteMutation as unknown as UseCollectionTreeParams["moveCollection"],
    upsertItem: upsertItem as unknown as UseCollectionTreeParams["upsertItem"],
    deleteItem: deleteMutation as unknown as UseCollectionTreeParams["deleteItem"],
    moveItem: deleteMutation as unknown as UseCollectionTreeParams["moveItem"],
    editor: {
      loadFromItem: vi.fn(),
      reset: vi.fn(),
    } as unknown as CollectionEditorState,
    setSelectedCollectionId: vi.fn(),
    setSelectedItemId: vi.fn(),
    t: (key) => key,
  };

  return { params, upsertCollection, upsertItem };
}

function fakeContextMenuEvent() {
  return {
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof useCollectionTree>["handleTreeContextMenu"]>[0];
}

function makeEditorItem(overrides: { id: string; collectionId: string; sortOrder: number }) {
  return {
    body: "",
    bodyType: "none",
    collectionId: overrides.collectionId,
    description: "",
    formData: [],
    formFiles: [],
    headers: [],
    id: overrides.id,
    method: "GET",
    name: overrides.id,
    rawLanguage: "json",
    sortOrder: overrides.sortOrder,
    url: "https://api.example.com/",
    urlEncoded: [],
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
    const { params } = makeParams(collections);
    const { result } = renderHook(() => useCollectionTree(params));

    armSpringLoad(result);
    expect(result.current.isFolderExpanded("col-b")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isFolderExpanded("col-b")).toBe(true);
  });

  it("clears the pending spring-load timer on unmount", () => {
    const collections = [makeCollection("col-a"), makeCollection("col-b")];
    const { params } = makeParams(collections);
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useCollectionTree(params));

    armSpringLoad(result);
    expect(result.current.isFolderExpanded("col-b")).toBe(false);

    unmount();

    // The unmount cleanup must have cleared the pending expand timer.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

// P2-5: renaming must echo the current sibling order. The commands default a
// missing `sortOrder` to 0, which silently moved the renamed entry to the top
// of its list (and flattening repeated saves).
describe("useCollectionTree rename keeps sort order", () => {
  it("keeps a folder's sort order", () => {
    const collections = [{ ...makeCollection("col-a"), sortOrder: 7 }];
    const { params, upsertCollection } = makeParams(collections);
    const { result } = renderHook(() => useCollectionTree(params));

    act(() => {
      result.current.handleTreeContextMenu(fakeContextMenuEvent(), {
        kind: "collection",
        id: "col-a",
        name: "col-a",
        parentId: null,
      });
    });
    act(() => {
      result.current.handleBeginRename();
    });
    act(() => {
      result.current.setRenameName("renamed");
    });
    act(() => {
      result.current.handleRenameSubmit();
    });

    expect(upsertCollection.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "col-a", name: "renamed", parentId: null, sortOrder: 7 }),
      expect.anything(),
    );
  });

  it("keeps a request item's sort order", () => {
    const collections = [makeCollection("col-a")];
    const { params, upsertItem } = makeParams(collections);
    const { result } = renderHook(() => useCollectionTree(params));

    act(() => {
      result.current.handleTreeContextMenu(fakeContextMenuEvent(), {
        kind: "item",
        item: makeEditorItem({ id: "item-1", collectionId: "col-a", sortOrder: 3 }),
      });
    });
    act(() => {
      result.current.handleBeginRename();
    });
    act(() => {
      result.current.setRenameName("renamed item");
    });
    act(() => {
      result.current.handleRenameSubmit();
    });

    expect(upsertItem.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-1", name: "renamed item", sortOrder: 3 }),
      expect.anything(),
    );
  });
});
