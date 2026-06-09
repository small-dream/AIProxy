import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { ApiCollection, ApiCollectionItem } from "@aiproxy/shared-types";

import { countTreeNodes, filterCollectionTree } from "@/features/collections/collection-tree.helpers";
import { APPEND_SORT_ORDER } from "@/features/collections/collections-layout.helpers";
import { parseDndId } from "@/features/collections/components/CollectionTreeNodeView";
import {
  computeDropIntent,
  isFolderCycleViolation,
  type DropPosition,
} from "@/features/collections/components/dnd-helpers";
import type {
  CollectionEditorItem,
  RenameTarget,
} from "@/features/collections/components/tree-types";
import type { CollectionTreeNode } from "@/features/collections/use-collections";
import type { UseMutationResult } from "@tanstack/react-query";
import type { CollectionSaveInput } from "@aiproxy/shared-types";
import type { CollectionEditorState } from "@/features/collections/collection-editor.store";
import type { TranslationKey, TranslationParams } from "@/i18n";

// --- Types for mutation callbacks ---

type UpsertCollectionMutation = UseMutationResult<
  ApiCollection,
  Error,
  { id?: string; parentId?: string | null; name: string; description?: string; sortOrder?: number }
>;

type DeleteCollectionMutation = UseMutationResult<void, Error, string>;

type MoveCollectionMutation = UseMutationResult<
  void,
  Error,
  { id: string; targetParentId: string | null; sortOrder: number }
>;

type UpsertItemMutation = UseMutationResult<ApiCollectionItem, Error, CollectionSaveInput>;

type DeleteItemMutation = UseMutationResult<
  void,
  Error,
  { id: string; collectionId: string }
>;

type MoveItemMutation = UseMutationResult<
  void,
  Error,
  { id: string; sourceCollectionId: string; targetCollectionId: string; sortOrder: number }
>;

export interface UseCollectionTreeParams {
  // Data
  collections: ApiCollection[];
  items: ApiCollectionItem[];
  tree: CollectionTreeNode[];
  selectedCollectionId: string | null;
  selectedItemId: string | null;
  collectionFilter: string;

  // Mutations
  upsertCollection: UpsertCollectionMutation;
  deleteCollection: DeleteCollectionMutation;
  moveCollection: MoveCollectionMutation;
  upsertItem: UpsertItemMutation;
  deleteItem: DeleteItemMutation;
  moveItem: MoveItemMutation;

  // Editor store
  editor: CollectionEditorState;

  // Selection setters
  setSelectedCollectionId: (id: string | null) => void;
  setSelectedItemId: (id: string | null) => void;

  // i18n
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

export interface UseCollectionTreeReturn {
  // Computed
  filteredTree: CollectionTreeNode[];
  collectionCount: number;
  isFolderExpanded: (id: string) => boolean;

  // DnD state
  activeDnd: { kind: "folder" | "item"; id: string; sourceCollectionId?: string } | null;
  dropTarget: { overDndId: string; position: DropPosition } | null;
  dndSensors: ReturnType<typeof useSensors>;

  // Context menu
  treeMenuState: { mouseX: number; mouseY: number; target: RenameTarget } | null;
  renameTarget: RenameTarget | null;
  renameName: string;
  moveError: string | null;

  // Handlers
  handleToggleExpand: (id: string, expanded: boolean) => void;
  handleDragStart: (event: DragStartEvent) => void;
  handleDragOver: (event: DragOverEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragCancel: () => void;
  handleTreeContextMenu: (event: ReactMouseEvent, target: RenameTarget) => void;
  handleTreeMenuClose: () => void;
  handleBeginRename: () => void;
  handleRenameCancel: () => void;
  handleRenameSubmit: () => void;
  handleDeleteCollection: (collectionId: string) => void;
  handleDeleteItem: (item: CollectionEditorItem) => void;

  // State setters (for dialogs)
  setTreeMenuState: (state: { mouseX: number; mouseY: number; target: RenameTarget } | null) => void;
  setRenameName: (name: string) => void;
  setMoveError: (error: string | null) => void;
}

export function useCollectionTree(params: UseCollectionTreeParams): UseCollectionTreeReturn {
  const {
    collections,
    items,
    tree,
    selectedCollectionId,
    selectedItemId,
    collectionFilter,
    upsertCollection,
    deleteCollection,
    moveCollection,
    upsertItem,
    deleteItem,
    moveItem,
    editor,
    setSelectedCollectionId,
    setSelectedItemId,
    t,
  } = params;

  // --- Folder expansion ---

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());

  const isFolderExpanded = useCallback(
    (id: string) => !collapsedFolders.has(id),
    [collapsedFolders],
  );

  const handleToggleExpand = useCallback((id: string, expanded: boolean) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (expanded) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // --- DnD state ---

  const [activeDnd, setActiveDnd] = useState<{
    kind: "folder" | "item";
    id: string;
    sourceCollectionId?: string;
  } | null>(null);

  const [dropTarget, setDropTarget] = useState<{
    overDndId: string;
    position: DropPosition;
  } | null>(null);

  const [moveError, setMoveError] = useState<string | null>(null);

  // Cursor tracking for DnD drop position calculation
  const cursorRef = useRef({ x: 0, y: 0 });
  const springLoadRef = useRef<{ folderId: string; timer: number } | null>(null);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    }
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // --- Context menu & rename ---

  const [treeMenuState, setTreeMenuState] = useState<{
    mouseX: number;
    mouseY: number;
    target: RenameTarget;
  } | null>(null);

  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameName, setRenameName] = useState("");

  // --- Computed ---

  const filteredTree = useMemo(
    () => filterCollectionTree(tree, collectionFilter),
    [tree, collectionFilter],
  );

  const collectionCount = useMemo(() => countTreeNodes(tree), [tree]);

  // --- Helpers ---

  function clearSpringLoad() {
    if (springLoadRef.current) {
      window.clearTimeout(springLoadRef.current.timer);
      springLoadRef.current = null;
    }
  }

  function findFolder(id: string): ApiCollection | undefined {
    return collections.find((c) => c.id === id);
  }

  function indexAmongCollectionSiblings(
    targetId: string,
    parentId: string | null,
    excludeId: string | null,
  ): number {
    const siblings = collections
      .filter((c) => c.parentId === parentId && c.id !== excludeId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return siblings.findIndex((c) => c.id === targetId);
  }

  function indexAmongItemSiblings(
    targetId: string,
    itemList: ApiCollectionItem[],
    excludeId: string | null,
  ): number {
    const sorted = itemList
      .filter((it) => it.id !== excludeId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return sorted.findIndex((it) => it.id === targetId);
  }

  // --- Context menu handlers ---

  function handleTreeContextMenu(event: ReactMouseEvent, target: RenameTarget) {
    event.preventDefault();
    event.stopPropagation();
    setTreeMenuState({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 4,
      target,
    });
  }

  function handleTreeMenuClose() {
    setTreeMenuState(null);
  }

  function handleBeginRename() {
    if (!treeMenuState) return;
    setRenameTarget(treeMenuState.target);
    setRenameName(
      treeMenuState.target.kind === "collection"
        ? treeMenuState.target.name
        : treeMenuState.target.item.name,
    );
    setTreeMenuState(null);
  }

  function handleRenameCancel() {
    setRenameTarget(null);
    setRenameName("");
  }

  function handleRenameSubmit() {
    const nextName = renameName.trim();
    if (!renameTarget || !nextName) return;

    if (renameTarget.kind === "collection") {
      upsertCollection.mutate(
        {
          id: renameTarget.id,
          name: nextName,
          parentId: renameTarget.parentId,
        },
        {
          onSuccess: () => handleRenameCancel(),
        },
      );
      return;
    }

    const item = renameTarget.item;
    upsertItem.mutate(
      {
        body: item.body,
        bodyType: item.bodyType,
        collectionId: item.collectionId,
        description: item.description,
        formData: item.formData,
        headers: item.headers,
        id: item.id,
        method: item.method,
        name: nextName,
        rawLanguage: item.rawLanguage,
        url: item.url,
        urlEncoded: item.urlEncoded,
      },
      {
        onSuccess: (updatedItem) => {
          if (selectedItemId === updatedItem.id) {
            editor.loadFromItem(updatedItem);
          }
          handleRenameCancel();
        },
      },
    );
  }

  // --- Collection/item deletion ---

  function handleDeleteCollection(collectionId: string) {
    deleteCollection.mutate(collectionId);
    if (selectedCollectionId === collectionId) {
      setSelectedCollectionId(null);
      setSelectedItemId(null);
      editor.reset();
    }
  }

  function handleDeleteItem(item: CollectionEditorItem) {
    deleteItem.mutate({ collectionId: item.collectionId, id: item.id });
    if (selectedItemId === item.id) {
      setSelectedItemId(null);
      editor.reset();
    }
  }

  // --- DnD handlers ---

  function handleDragStart(event: DragStartEvent) {
    const parsed = parseDndId(String(event.active.id));
    if (!parsed) return;
    setActiveDnd({
      kind: parsed.kind,
      id: parsed.id,
      ...(parsed.kind === "item" && selectedCollectionId
        ? { sourceCollectionId: selectedCollectionId }
        : {}),
    });
  }

  function handleDragOver(event: DragOverEvent) {
    const { over } = event;
    if (!over || !activeDnd) {
      setDropTarget(null);
      clearSpringLoad();
      return;
    }

    const overParsed = parseDndId(String(over.id));
    if (!overParsed) {
      setDropTarget(null);
      clearSpringLoad();
      return;
    }

    if (overParsed.kind === "folder" && overParsed.id === activeDnd.id) {
      setDropTarget(null);
      clearSpringLoad();
      return;
    }

    const overRect = over.rect;
    if (!overRect) {
      setDropTarget(null);
      clearSpringLoad();
      return;
    }

    const overFolder = overParsed.kind === "folder" ? findFolder(overParsed.id) : null;
    const overIsExpanded = overParsed.kind === "folder" ? isFolderExpanded(overParsed.id) : false;
    const overHasChildren = overFolder
      ? collections.some((c) => c.parentId === overFolder.id) ||
        (overFolder.id === selectedCollectionId && items.length > 0)
      : false;

    const intent = computeDropIntent({
      activeKind: activeDnd.kind,
      overKind: overParsed.kind,
      overTop: overRect.top,
      overHeight: overRect.height,
      cursorY: cursorRef.current.y,
      overIsExpanded,
      overHasChildren,
    });

    if (!intent) {
      setDropTarget(null);
      clearSpringLoad();
      return;
    }

    if (activeDnd.kind === "folder") {
      const targetParentId =
        intent === "into"
          ? overParsed.id
          : overParsed.kind === "folder"
            ? (findFolder(overParsed.id)?.parentId ?? null)
            : null;
      if (isFolderCycleViolation(activeDnd.id, targetParentId, collections)) {
        setDropTarget(null);
        clearSpringLoad();
        return;
      }
    }

    setDropTarget({ overDndId: String(over.id), position: intent });

    if (
      activeDnd.kind === "folder" &&
      overParsed.kind === "folder" &&
      intent === "into" &&
      !overIsExpanded
    ) {
      if (springLoadRef.current?.folderId !== overParsed.id) {
        clearSpringLoad();
        const folderId = overParsed.id;
        const timer = window.setTimeout(() => {
          handleToggleExpand(folderId, true);
          springLoadRef.current = null;
        }, 500);
        springLoadRef.current = { folderId, timer };
      }
    } else {
      clearSpringLoad();
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    clearSpringLoad();
    const active = activeDnd;
    const over = dropTarget;
    setActiveDnd(null);
    setDropTarget(null);

    if (!active || !over) return;

    const overParsed = parseDndId(over.overDndId);
    if (!overParsed) return;
    if (event.active.id === event.over?.id && over.position === "into") return;

    if (active.kind === "folder") {
      let targetParentId: string | null;
      let sortOrder: number;
      if (over.position === "into") {
        if (overParsed.kind !== "folder") return;
        targetParentId = overParsed.id;
        const childCount = collections.filter(
          (c) => c.parentId === targetParentId && c.id !== active.id,
        ).length;
        sortOrder = childCount;
      } else {
        if (overParsed.kind !== "folder") return;
        const overFolder = findFolder(overParsed.id);
        if (!overFolder) return;
        targetParentId = overFolder.parentId;
        const baseIdx = indexAmongCollectionSiblings(overParsed.id, targetParentId, active.id);
        if (baseIdx === -1) return;
        sortOrder = over.position === "after" ? baseIdx + 1 : baseIdx;
      }
      if (isFolderCycleViolation(active.id, targetParentId, collections)) return;
      if (over.position === "into" && targetParentId) {
        handleToggleExpand(targetParentId, true);
      }
      moveCollection.mutate(
        { id: active.id, targetParentId, sortOrder },
        {
          onError: (err: unknown) => {
            const msg =
              err instanceof Error && err.message.includes("descendant")
                ? t("collectionsPage.moveCycleBlocked")
                : t("collectionsPage.moveFailed");
            setMoveError(msg);
          },
        },
      );
      return;
    }

    if (active.kind === "item") {
      const sourceCollectionId = active.sourceCollectionId ?? selectedCollectionId;
      if (!sourceCollectionId) return;

      let targetCollectionId: string;
      let sortOrder: number;
      if (over.position === "into") {
        if (overParsed.kind !== "folder") return;
        targetCollectionId = overParsed.id;
        sortOrder =
          targetCollectionId === sourceCollectionId
            ? items.filter((it) => it.id !== active.id).length
            : APPEND_SORT_ORDER;
      } else {
        if (overParsed.kind !== "item") return;
        targetCollectionId = sourceCollectionId;
        const baseIdx = indexAmongItemSiblings(overParsed.id, items, active.id);
        if (baseIdx === -1) return;
        sortOrder = over.position === "after" ? baseIdx + 1 : baseIdx;
      }

      const isCrossFolder = targetCollectionId !== sourceCollectionId;
      if (isCrossFolder) {
        handleToggleExpand(targetCollectionId, true);
        setSelectedCollectionId(targetCollectionId);
      }

      moveItem.mutate(
        {
          id: active.id,
          sourceCollectionId,
          targetCollectionId,
          sortOrder,
        },
        {
          onError: () => {
            setMoveError(t("collectionsPage.moveFailed"));
          },
        },
      );
    }
  }

  function handleDragCancel() {
    clearSpringLoad();
    setActiveDnd(null);
    setDropTarget(null);
  }

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  return {
    // Computed
    filteredTree,
    collectionCount,
    isFolderExpanded,

    // DnD state
    activeDnd,
    dropTarget,
    dndSensors,

    // Context menu
    treeMenuState,
    renameTarget,
    renameName,
    moveError,

    // Handlers
    handleToggleExpand,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    handleTreeContextMenu,
    handleTreeMenuClose,
    handleBeginRename,
    handleRenameCancel,
    handleRenameSubmit,
    handleDeleteCollection,
    handleDeleteItem,

    // State setters
    setTreeMenuState,
    setRenameName,
    setMoveError,
  };
}
