import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import AccountTreeRoundedIcon from "@mui/icons-material/AccountTreeRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import CreateNewFolderRoundedIcon from "@mui/icons-material/CreateNewFolderRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  OutlinedInput,
  Select,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { alpha } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { ApiCollection, ApiCollectionItem, HeaderEntry } from "@aiproxy/shared-types";

import { ComposeRequestSection } from "@/features/compose/components/ComposeRequestSection";
import { ComposeResponseSection, type ComposeResponseTab } from "@/features/compose/components/ComposeResponseSection";
import { buildMultipartBody, FORMDATA_CONTENT_TYPE, RAW_LANGUAGE_CONTENT_TYPE, URLENCODED_CONTENT_TYPE } from "@/features/compose/compose-editor.store";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { useCollectionEditorStore } from "@/features/collections/collection-editor.store";
import { CollectionTreeNodeView, parseDndId } from "@/features/collections/components/CollectionTreeNodeView";
import { computeDropIntent, isFolderCycleViolation, type DropPosition } from "@/features/collections/components/dnd-helpers";
import type { CollectionEditorItem, RenameTarget } from "@/features/collections/components/tree-types";
import {
  useCollectionItems,
  useDeleteCollectionItem,
  useMoveCollectionItem,
  useUpsertCollectionItem,
} from "@/features/collections/use-collection-items";
import {
  buildCollectionTree,
  type CollectionTreeNode,
  useCollections,
  useDeleteCollection,
  useMoveCollection,
  useUpsertCollection,
} from "@/features/collections/use-collections";
import { EnvironmentManagerDialog } from "@/features/environments/components/EnvironmentManagerDialog";
import {
  buildMergedVariableMap,
  substituteVariables,
  useEnvironmentVariables,
  useEnvironments,
  useGlobalVariables,
} from "@/features/environments/use-environments";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  clampInspectorSplitRatio,
} from "@/features/sessions/components/session-inspector.helpers";
import { readStorageValue, writeStorageValue } from "@/features/sessions/session-ui.helpers";
import { useI18n } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const EXPLORER_WIDTH_STORAGE_KEY = "aiproxy.collections.explorerWidth";
const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.collections.inspectorSplitRatio";
const REQUEST_COLLAPSED_STORAGE_KEY = "aiproxy.collections.requestCollapsed";
const EXPLORER_WIDTH_MIN = 260;
const EXPLORER_WIDTH_MAX = 520;
const APPEND_SORT_ORDER = 0xffffffff;

function clampExplorerWidth(width: number): number {
  return Math.min(EXPLORER_WIDTH_MAX, Math.max(EXPLORER_WIDTH_MIN, width));
}

function ensureContentType(headers: HeaderEntry[], contentType: string): HeaderEntry[] {
  if (headers.some((h) => h.name.toLowerCase() === "content-type")) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}

function countTreeNodes(nodes: CollectionTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

function filterCollectionTree(nodes: CollectionTreeNode[], query: string): CollectionTreeNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return nodes;

  return nodes.flatMap((node) => {
    const children = filterCollectionTree(node.children, normalized);
    if (node.name.toLowerCase().includes(normalized) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}

export function CollectionsPage() {
  const { t } = useI18n();

  const collectionsQuery = useCollections();
  const upsertCollection = useUpsertCollection();
  const deleteCollectionMutation = useDeleteCollection();
  const collections = useMemo(() => collectionsQuery.data ?? [], [collectionsQuery.data]);
  const tree = useMemo(() => buildCollectionTree(collections), [collections]);

  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [collectionFilter, setCollectionFilter] = useState("");

  const itemsQuery = useCollectionItems(selectedCollectionId);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);

  const editor = useCollectionEditorStore();
  const sendMutation = useSendComposedRequest();
  const explorerDragFrameRef = useRef<number | null>(null);
  const inspectorDragFrameRef = useRef<number | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const parsedWidth = Number(readStorageValue(EXPLORER_WIDTH_STORAGE_KEY));
    return Number.isFinite(parsedWidth) ? clampExplorerWidth(parsedWidth) : 320;
  });
  const [inspectorSplitRatio, setInspectorSplitRatio] = useState(() => {
    const parsedRatio = Number(readStorageValue(INSPECTOR_SPLIT_RATIO_STORAGE_KEY));
    return Number.isFinite(parsedRatio) ? clampInspectorSplitRatio(parsedRatio) : DEFAULT_REQUEST_SPLIT_RATIO;
  });
  const [requestCollapsed, setRequestCollapsed] = useState(() => readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true");

  const ACTIVE_ENV_KEY = "aiproxy.collections.activeEnvironmentId";
  const environmentsQuery = useEnvironments();
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(ACTIVE_ENV_KEY);
  });
  const envVarsQuery = useEnvironmentVariables(activeEnvironmentId);
  const globalVarsQuery = useGlobalVariables();
  const mergedVarMap = useMemo(
    () => buildMergedVariableMap(envVarsQuery.data ?? [], globalVarsQuery.data ?? []),
    [envVarsQuery.data, globalVarsQuery.data],
  );

  useEffect(() => {
    if (activeEnvironmentId) {
      window.localStorage.setItem(ACTIVE_ENV_KEY, activeEnvironmentId);
    } else {
      window.localStorage.removeItem(ACTIVE_ENV_KEY);
    }
  }, [activeEnvironmentId]);

  useEffect(() => {
    writeStorageValue(EXPLORER_WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    writeStorageValue(INSPECTOR_SPLIT_RATIO_STORAGE_KEY, String(inspectorSplitRatio));
  }, [inspectorSplitRatio]);

  useEffect(() => {
    writeStorageValue(REQUEST_COLLAPSED_STORAGE_KEY, String(requestCollapsed));
  }, [requestCollapsed]);

  useEffect(() => {
    return () => {
      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }
      if (inspectorDragFrameRef.current) {
        window.cancelAnimationFrame(inspectorDragFrameRef.current);
      }
    };
  }, []);

  const upsertItemMutation = useUpsertCollectionItem();
  const deleteItemMutation = useDeleteCollectionItem();

  const [newCollectionDialogOpen, setNewCollectionDialogOpen] = useState(false);
  const [newCollectionParentId, setNewCollectionParentId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [manageEnvDialogOpen, setManageEnvDialogOpen] = useState(false);
  const [treeMenuState, setTreeMenuState] = useState<{
    mouseX: number;
    mouseY: number;
    target: RenameTarget;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameName, setRenameName] = useState("");

  const [requestTab, setRequestTab] = useState<"headers" | "body" | "query">("headers");
  const [responseTab, setResponseTab] = useState<ComposeResponseTab>("overview");

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [activeDnd, setActiveDnd] = useState<{
    kind: "folder" | "item";
    id: string;
    sourceCollectionId?: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ overDndId: string; position: DropPosition } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const cursorRef = useRef({ x: 0, y: 0 });
  const springLoadRef = useRef<{ folderId: string; timer: number } | null>(null);

  const moveCollection = useMoveCollection();
  const moveCollectionItem = useMoveCollectionItem();

  useEffect(() => {
    function onMove(e: PointerEvent) {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    }
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

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

  function clearSpringLoad() {
    if (springLoadRef.current) {
      window.clearTimeout(springLoadRef.current.timer);
      springLoadRef.current = null;
    }
  }

  const filteredTree = useMemo(() => filterCollectionTree(tree, collectionFilter), [tree, collectionFilter]);

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
    setRenameName(treeMenuState.target.kind === "collection" ? treeMenuState.target.name : treeMenuState.target.item.name);
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
    upsertItemMutation.mutate(
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

  function handleSelectCollection(collectionId: string) {
    setSelectedCollectionId(collectionId);
  }

  function handleSelectItem(item: CollectionEditorItem) {
    setSelectedCollectionId(item.collectionId);
    setSelectedItemId(item.id);
    setRequestTab("headers");
    editor.loadFromItem(item);
  }

  function handleCreateRequest(collectionId = selectedCollectionId) {
    if (!collectionId) return;
    editor.reset();
    useCollectionEditorStore.setState({ collectionId });
    setSelectedCollectionId(collectionId);
    setSelectedItemId(null);
    setRequestTab("headers");
    setResponseTab("overview");
  }

  function handleSend() {
    const substitutedUrl = substituteVariables(editor.url, mergedVarMap);
    const substitutedBody = substituteVariables(editor.body, mergedVarMap);

    let finalHeaders = editor.headers.map((h) => ({
      name: substituteVariables(h.name, mergedVarMap),
      value: substituteVariables(h.value, mergedVarMap),
    }));

    let encodedBody: string | undefined;
    switch (editor.bodyType) {
      case "formdata": {
        const active = editor.formDataEntries
          .filter((e) => substituteVariables(e.name, mergedVarMap).trim())
          .map((e) => ({
            name: substituteVariables(e.name, mergedVarMap),
            value: substituteVariables(e.value, mergedVarMap),
          }));
        if (active.length > 0) {
          const boundary = `----AIProxyBoundary${Date.now().toString(16)}`;
          encodedBody = buildMultipartBody(active, boundary);
          finalHeaders = ensureContentType(finalHeaders, `${FORMDATA_CONTENT_TYPE}; boundary=${boundary}`);
        }
        break;
      }
      case "urlencoded": {
        const active = editor.urlEncodedEntries
          .filter((e) => substituteVariables(e.name, mergedVarMap).trim())
          .map((e) => ({
            name: substituteVariables(e.name, mergedVarMap),
            value: substituteVariables(e.value, mergedVarMap),
          }));
        if (active.length > 0) {
          encodedBody = active
            .map((e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
            .join("&");
          finalHeaders = ensureContentType(finalHeaders, URLENCODED_CONTENT_TYPE);
        }
        break;
      }
      case "raw": {
        if (substitutedBody.trim()) {
          encodedBody = substitutedBody;
          finalHeaders = ensureContentType(finalHeaders, RAW_LANGUAGE_CONTENT_TYPE[editor.rawLanguage]);
        }
        break;
      }
    }

    sendMutation.mutate({
      workspaceId: "default",
      method: editor.method,
      url: substitutedUrl,
      headers: finalHeaders,
      ...(encodedBody ? { body: encodedBody } : {}),
    });
  }

  function handleSave() {
    if (!editor.collectionId) return;
    upsertItemMutation.mutate(
      {
        ...(editor.itemId ? { id: editor.itemId } : {}),
        body: editor.body,
        bodyType: editor.bodyType,
        collectionId: editor.collectionId,
        description: editor.description,
        formData: editor.formDataEntries,
        headers: editor.headers,
        method: editor.method,
        name: editor.name || `${editor.method} ${editor.url}`,
        rawLanguage: editor.rawLanguage,
        url: editor.url,
        urlEncoded: editor.urlEncodedEntries,
      },
      {
        onSuccess: (item) => {
          setSelectedCollectionId(item.collectionId);
          setSelectedItemId(item.id);
          editor.loadFromItem(item);
        },
      },
    );
  }

  function handleCreateCollection() {
    if (!newCollectionName.trim()) return;
    upsertCollection.mutate(
      {
        name: newCollectionName.trim(),
        parentId: newCollectionParentId,
      },
      {
        onSuccess: (collection) => {
          setSelectedCollectionId(collection.id);
          setNewCollectionDialogOpen(false);
          setNewCollectionName("");
        },
      },
    );
  }

  function handleDeleteCollection(collectionId: string) {
    deleteCollectionMutation.mutate(collectionId);
    if (selectedCollectionId === collectionId) {
      setSelectedCollectionId(null);
      setSelectedItemId(null);
      editor.reset();
    }
  }

  function findFolder(id: string): ApiCollection | undefined {
    return collections.find((c) => c.id === id);
  }

  function indexAmongCollectionSiblings(targetId: string, parentId: string | null, excludeId: string | null): number {
    const siblings = collections
      .filter((c) => c.parentId === parentId && c.id !== excludeId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return siblings.findIndex((c) => c.id === targetId);
  }

  function indexAmongItemSiblings(targetId: string, itemList: ApiCollectionItem[], excludeId: string | null): number {
    const sorted = itemList
      .filter((it) => it.id !== excludeId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return sorted.findIndex((it) => it.id === targetId);
  }

  function handleDragStart(event: DragStartEvent) {
    const parsed = parseDndId(String(event.active.id));
    if (!parsed) return;
    setActiveDnd({
      kind: parsed.kind,
      id: parsed.id,
      ...(parsed.kind === "item" && selectedCollectionId ? { sourceCollectionId: selectedCollectionId } : {}),
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
      ? collections.some((c) => c.parentId === overFolder.id) || (overFolder.id === selectedCollectionId && items.length > 0)
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
            ? findFolder(overParsed.id)?.parentId ?? null
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
        const childCount = collections.filter((c) => c.parentId === targetParentId && c.id !== active.id).length;
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
            const msg = err instanceof Error && err.message.includes("descendant")
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
        sortOrder = targetCollectionId === sourceCollectionId
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

      moveCollectionItem.mutate(
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

  function startExplorerResize(event: ReactPointerEvent<HTMLDivElement>) {
    const container = event.currentTarget.parentElement;
    if (!container) return;

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateWidth = (clientX: number) => {
      const bounds = container.getBoundingClientRect();
      const nextWidth = clampExplorerWidth(clientX - bounds.left);

      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }

      explorerDragFrameRef.current = window.requestAnimationFrame(() => {
        setExplorerWidth(nextWidth);
      });
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  const startInspectorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container || requestCollapsed) return;

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateRatio = (clientY: number) => {
      const bounds = container.getBoundingClientRect();
      if (bounds.height <= 0) return;

      const nextRatio = clampInspectorSplitRatio((clientY - bounds.top) / bounds.height);

      if (inspectorDragFrameRef.current) {
        window.cancelAnimationFrame(inspectorDragFrameRef.current);
      }

      inspectorDragFrameRef.current = window.requestAnimationFrame(() => {
        setInspectorSplitRatio(nextRatio);
      });
    };

    updateRatio(event.clientY);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientY);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [requestCollapsed]);

  const responseDetail = sendMutation.data;
  const collectionCount = countTreeNodes(tree);

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        display: "grid",
        gap: 0,
        gridTemplateColumns: `${explorerWidth}px 1px minmax(0, 1fr)`,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        p: 0,
      }}
    >
      <WorkbenchPane
        sx={{
          borderRight: 0,
          borderBottomRightRadius: 0,
          borderTopRightRadius: 0,
        }}
      >
        <PaneHeader
          icon={<AccountTreeRoundedIcon />}
          meta={t("collectionsPage.collectionCount", { count: collectionCount })}
          title={t("collectionsPage.library")}
          actions={(
            <Tooltip title={t("collectionsPage.newCollection")}>
              <IconButton
                size="small"
                onClick={() => {
                  setNewCollectionParentId(null);
                  setNewCollectionDialogOpen(true);
                }}
              >
                <CreateNewFolderRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        />
        <Box sx={{ px: 1.25, pb: 1 }}>
          <SearchInput
            onChange={setCollectionFilter}
            placeholder={t("collectionsPage.searchCollections")}
            value={collectionFilter}
          />
        </Box>
        <Divider />

        <Box sx={{ flex: "1 1 0", minHeight: 0, overflow: "auto", py: 0.625 }}>
          {collectionsQuery.isLoading ? (
            <LoadingState />
          ) : filteredTree.length > 0 ? (
            <DndContext
              collisionDetection={pointerWithin}
              sensors={dndSensors}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {filteredTree.map((node) => (
                <CollectionTreeNodeView
                  key={node.id}
                  depth={0}
                  deleteItemLabel={t("collectionsPage.deleteItem")}
                  isFolderExpanded={isFolderExpanded}
                  isItemsLoading={itemsQuery.isLoading}
                  node={node}
                  onAddChild={(parentId) => {
                    setNewCollectionParentId(parentId);
                    setNewCollectionDialogOpen(true);
                  }}
                  onContextMenu={handleTreeContextMenu}
                  onDelete={handleDeleteCollection}
                  onDeleteItem={(item) => {
                    deleteItemMutation.mutate({ collectionId: item.collectionId, id: item.id });
                    if (selectedItemId === item.id) {
                      setSelectedItemId(null);
                      editor.reset();
                    }
                  }}
                  onNewRequest={handleCreateRequest}
                  onSelect={handleSelectCollection}
                  onSelectItem={handleSelectItem}
                  onToggleExpand={handleToggleExpand}
                  overId={dropTarget?.overDndId ?? null}
                  overPosition={dropTarget?.position ?? null}
                  selectedCollectionItems={items}
                  selectedCollectionId={selectedCollectionId}
                  selectedItemId={selectedItemId}
                  t={t}
                />
              ))}
            </DndContext>
          ) : (
            <EmptyPaneState
              actionLabel={t("collectionsPage.newCollection")}
              icon={<FolderRoundedIcon />}
              onAction={() => {
                setNewCollectionParentId(null);
                setNewCollectionDialogOpen(true);
              }}
              title={t("collectionsPage.emptyCollections")}
            />
          )}
        </Box>

        <Divider />
        <Box sx={{ p: 1 }}>
          <Stack
            direction="row"
            spacing={0.75}
            sx={(theme) => ({
              alignItems: "center",
              bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.1 : 0.06),
              border: 1,
              borderColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.22 : 0.16),
              borderRadius: 1,
              p: 0.75,
            })}
          >
            <BoltRoundedIcon sx={{ color: "primary.main", flex: "0 0 auto", fontSize: 18 }} />
            <Typography noWrap sx={{ flex: 1, fontSize: 12, fontWeight: 700, minWidth: 0 }}>
              {t("collectionsPage.environmentSelector")}
            </Typography>
            <Select
              size="small"
              value={activeEnvironmentId ?? ""}
              onChange={(e) => setActiveEnvironmentId(e.target.value || null)}
              sx={{
                bgcolor: "background.paper",
                flex: "0 0 132px",
                fontSize: 12,
                "& .MuiSelect-select": { py: 0.75 },
              }}
            >
              <MenuItem value="">
                <em>{t("collectionsPage.noEnvironment")}</em>
              </MenuItem>
              {(environmentsQuery.data ?? []).map((env) => (
                <MenuItem key={env.id} value={env.id}>
                  {env.name}
                </MenuItem>
              ))}
            </Select>
            <Tooltip title={t("collectionsPage.manageEnvironments")}>
              <IconButton size="small" onClick={() => setManageEnvDialogOpen(true)} sx={{ color: "text.secondary", flex: "0 0 auto" }}>
                <SettingsRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </WorkbenchPane>

      <Box
        aria-hidden
        onPointerDown={startExplorerResize}
        sx={{
          alignItems: "center",
          cursor: "col-resize",
          display: "flex",
          justifyContent: "center",
          minHeight: 0,
          position: "relative",
          touchAction: "none",
          userSelect: "none",
          "&::before": {
            bgcolor: (theme) => alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
            content: '""',
            height: "100%",
            opacity: 1,
            transition: "background-color 120ms ease, opacity 120ms ease",
            width: 1,
          },
          "&::after": {
            content: '""',
            inset: "0 -3px",
            position: "absolute",
          },
          "&:hover::before": {
            bgcolor: "primary.main",
          },
        }}
      />

      <WorkbenchPane
        sx={{
          borderBottomLeftRadius: 0,
          borderTopLeftRadius: 0,
          minWidth: 0,
        }}
      >
        {editor.collectionId ? (
          <Stack sx={{ flex: 1, minHeight: 0 }}>
            <Box
              sx={(theme) => ({
                bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.74 : 0.86),
                borderBottom: 1,
                borderColor: "divider",
                flexShrink: 0,
                p: 1,
              })}
            >
              <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
                <Select
                  size="small"
                  sx={{
                    flex: "0 0 112px",
                    fontFamily: appFontCssVars.content,
                    fontSize: 13,
                    fontWeight: 800,
                    "& .MuiSelect-select": {
                      alignItems: "center",
                      display: "flex",
                      py: 0.9,
                    },
                  }}
                  value={editor.method}
                  onChange={(e) => editor.setMethod(e.target.value)}
                >
                  {HTTP_METHODS.map((method) => (
                    <MenuItem key={method} sx={{ fontFamily: appFontCssVars.content, fontSize: 13, fontWeight: 700 }} value={method}>
                      {method}
                    </MenuItem>
                  ))}
                </Select>
                <OutlinedInput
                  fullWidth
                  placeholder={t("composePage.urlPlaceholder")}
                  size="small"
                  startAdornment={(
                    <InputAdornment position="start">
                      <LinkRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
                    </InputAdornment>
                  )}
                  sx={(theme) => ({
                    bgcolor: alpha(theme.palette.background.default, theme.palette.mode === "dark" ? 0.38 : 0.62),
                    fontFamily: appFontCssVars.content,
                    fontSize: 13,
                    minWidth: 0,
                    "& .MuiOutlinedInput-input": {
                      py: 1,
                    },
                  })}
                  value={editor.url}
                  onChange={(e) => editor.setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && editor.url.trim()) handleSend();
                  }}
                />
                <Tooltip title={t("collectionsPage.saveRequest")}>
                  <span>
                    <Button
                      disabled={upsertItemMutation.isPending}
                      onClick={handleSave}
                      size="small"
                      sx={{ flex: "0 0 auto", minHeight: 36, minWidth: 104 }}
                      variant="outlined"
                    >
                      {editor.itemId ? t("collectionsPage.updateRequest") : t("collectionsPage.saveAsNew")}
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={t("collectionsPage.sendRequest")}>
                  <span>
                    <Button
                      disabled={!editor.url.trim() || sendMutation.isPending}
                      onClick={handleSend}
                      size="small"
                      startIcon={sendMutation.isPending ? undefined : <SendRoundedIcon />}
                      sx={{ flex: "0 0 auto", minHeight: 36, minWidth: 88 }}
                      variant="contained"
                    >
                      {sendMutation.isPending ? <CircularProgress color="inherit" size={18} /> : t("collectionsPage.sendRequest")}
                    </Button>
                  </span>
                </Tooltip>
              </Stack>

              <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mt: 0.75, minWidth: 0 }}>
                <TextField
                  placeholder={t("collectionsPage.requestName")}
                  size="small"
                  value={editor.name}
                  onChange={(e) => editor.setName(e.target.value)}
                  sx={{
                    flex: "0 1 280px",
                    minWidth: 180,
                    "& .MuiInputBase-input": {
                      fontSize: 13,
                      fontWeight: 700,
                      py: 0.75,
                    },
                  }}
                />
                <TextField
                  placeholder={t("collectionsPage.descriptionPlaceholder")}
                  size="small"
                  value={editor.description}
                  onChange={(e) => editor.setDescription(e.target.value)}
                  sx={{
                    flex: "1 1 240px",
                    minWidth: 0,
                    "& .MuiInputBase-input": {
                      color: "text.secondary",
                      fontSize: 12.5,
                      py: 0.75,
                    },
                  }}
                />
              </Stack>
            </Box>

            <Box
              sx={{
                display: "grid",
                flex: "1 1 0",
                gridTemplateRows: requestCollapsed
                  ? "auto 1px minmax(0, 1fr)"
                  : `${inspectorSplitRatio}fr 1px ${1 - inspectorSplitRatio}fr`,
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              <ComposeRequestSection
                activeTab={requestTab}
                body={editor.body}
                bodyType={editor.bodyType}
                chromeless
                formDataEntries={editor.formDataEntries}
                headers={editor.headers}
                onActiveTabChange={setRequestTab}
                onBodyChange={editor.setBody}
                onBodyTypeChange={editor.setBodyType}
                onFormDataEntriesChange={editor.setFormDataEntries}
                onHeadersChange={editor.setHeaders}
                onRequestCollapsedChange={setRequestCollapsed}
                onRawLanguageChange={editor.setRawLanguage}
                onUrlChange={editor.setUrl}
                onUrlEncodedEntriesChange={editor.setUrlEncodedEntries}
                rawLanguage={editor.rawLanguage}
                requestCollapsed={requestCollapsed}
                url={editor.url}
                urlEncodedEntries={editor.urlEncodedEntries}
              />

              {requestCollapsed ? (
                <Divider />
              ) : (
                <Box
                  aria-hidden
                  onPointerDown={startInspectorResize}
                  sx={{
                    alignItems: "center",
                    cursor: "row-resize",
                    display: "flex",
                    justifyContent: "center",
                    minHeight: 0,
                    position: "relative",
                    touchAction: "none",
                    userSelect: "none",
                    "&::before": {
                      bgcolor: (theme) => alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.76 : 1),
                      content: '""',
                      height: 1,
                      opacity: 1,
                      transition: "background-color 120ms ease, opacity 120ms ease",
                      width: "100%",
                    },
                    "&::after": {
                      content: '""',
                      inset: "-3px 0",
                      position: "absolute",
                    },
                    "&:hover::before": {
                      bgcolor: "primary.main",
                      opacity: 1,
                    },
                  }}
                />
              )}

              <ComposeResponseSection
                chromeless
                errorMessage={sendMutation.error?.message}
                isError={sendMutation.isError}
                isPending={sendMutation.isPending}
                onResponseTabChange={setResponseTab}
                responseDetail={responseDetail}
                responseTab={responseTab}
              />
            </Box>
          </Stack>
        ) : (
          <EmptyWorkspace
            collectionSelected={Boolean(selectedCollectionId)}
            onCreateRequest={() => handleCreateRequest()}
            t={t}
          />
        )}
      </WorkbenchPane>

      <Menu
        anchorPosition={treeMenuState ? { left: treeMenuState.mouseX, top: treeMenuState.mouseY } : undefined}
        anchorReference="anchorPosition"
        onClose={handleTreeMenuClose}
        open={Boolean(treeMenuState)}
      >
        <MenuItem onClick={handleBeginRename}>
          {t("collectionsPage.rename")}
        </MenuItem>
      </Menu>

      <Dialog
        fullWidth
        maxWidth="xs"
        open={newCollectionDialogOpen}
        onClose={() => setNewCollectionDialogOpen(false)}
      >
        <DialogTitle>
          {newCollectionParentId ? t("collectionsPage.newFolder") : t("collectionsPage.newCollection")}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={t("collectionsPage.namePlaceholder")}
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateCollection();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewCollectionDialogOpen(false)}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            disabled={!newCollectionName.trim()}
            onClick={handleCreateCollection}
            variant="contained"
          >
            {t("common.actions.add")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        fullWidth
        maxWidth="xs"
        open={Boolean(renameTarget)}
        onClose={handleRenameCancel}
      >
        <DialogTitle>{t("collectionsPage.rename")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={renameTarget?.kind === "item" ? t("collectionsPage.requestName") : t("collectionsPage.namePlaceholder")}
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleRenameCancel}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            disabled={!renameName.trim()}
            onClick={handleRenameSubmit}
            variant="contained"
          >
            {t("collectionsPage.rename")}
          </Button>
        </DialogActions>
      </Dialog>

      <EnvironmentManagerDialog
        onClose={() => setManageEnvDialogOpen(false)}
        open={manageEnvDialogOpen}
      />

      <Snackbar
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        autoHideDuration={3000}
        message={moveError ?? ""}
        onClose={() => setMoveError(null)}
        open={moveError !== null}
      />
    </Box>
  );
}

function WorkbenchPane({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  const paneSx = [
    (theme: Theme) => ({
      bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.78 : 0.96),
      border: 1,
      borderColor: "divider",
      borderRadius: 1.25,
      boxShadow: "none",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
      overflow: "hidden",
    }),
    ...(sx ? (Array.isArray(sx) ? sx : [sx]) : []),
  ] as SxProps<Theme>;

  return (
    <Box
      sx={paneSx}
    >
      {children}
    </Box>
  );
}

function PaneHeader({
  actions,
  icon,
  meta,
  title,
}: {
  actions?: ReactNode;
  icon: ReactNode;
  meta: string;
  title: string;
}) {
  return (
    <Stack direction="row" spacing={0.875} sx={{ alignItems: "center", flexShrink: 0, minHeight: 54, px: 1.125 }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.09),
          borderRadius: 1,
          color: "primary.main",
          display: "flex",
          height: 32,
          justifyContent: "center",
          width: 32,
          "& svg": { fontSize: 18 },
        })}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 800 }}>
          {title}
        </Typography>
        <Typography color="text.secondary" noWrap sx={{ fontSize: 11.25 }}>
          {meta}
        </Typography>
      </Box>
      {actions}
    </Stack>
  );
}

function SearchInput({
  disabled = false,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <OutlinedInput
      disabled={disabled}
      fullWidth
      placeholder={placeholder}
      size="small"
      startAdornment={(
        <InputAdornment position="start">
          <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 17 }} />
        </InputAdornment>
      )}
      sx={(theme) => ({
        bgcolor: alpha(theme.palette.background.default, theme.palette.mode === "dark" ? 0.28 : 0.52),
        fontSize: 12.25,
        "& .MuiOutlinedInput-input": {
          py: 0.75,
        },
      })}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function LoadingState() {
  return (
    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 140 }}>
      <CircularProgress size={22} />
    </Stack>
  );
}

function EmptyPaneState({
  actionLabel,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  icon: ReactNode;
  onAction?: () => void;
  title: string;
}) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.25} sx={{ minHeight: 180, px: 2, textAlign: "center" }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.06 : 0.045),
          borderRadius: 1,
          color: "text.secondary",
          display: "flex",
          height: 42,
          justifyContent: "center",
          width: 42,
          "& svg": { fontSize: 22 },
        })}
      >
        {icon}
      </Box>
      <Typography color="text.secondary" sx={{ fontSize: 12.5, lineHeight: 1.45 }}>
        {title}
      </Typography>
      {actionLabel && onAction ? (
        <Button onClick={onAction} size="small" startIcon={<AddRoundedIcon />} variant="outlined">
          {actionLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

function EmptyWorkspace({
  collectionSelected,
  onCreateRequest,
  t,
}: {
  collectionSelected: boolean;
  onCreateRequest: () => void;
  t: (key: TranslationKey) => string;
}) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ flex: 1, px: 4, textAlign: "center" }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.14 : 0.08),
          border: 1,
          borderColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.24 : 0.16),
          borderRadius: 1.5,
          color: "primary.main",
          display: "flex",
          height: 64,
          justifyContent: "center",
          width: 64,
          "& svg": { fontSize: 34 },
        })}
      >
        <ArticleRoundedIcon />
      </Box>
      <Typography sx={{ fontSize: 18, fontWeight: 800 }}>
        {collectionSelected ? t("collectionsPage.readyToCreateRequest") : t("collectionsPage.noCollectionSelected")}
      </Typography>
      <Typography color="text.secondary" sx={{ fontSize: 13, maxWidth: 420 }}>
        {collectionSelected ? t("collectionsPage.createRequestHint") : t("collectionsPage.selectCollectionHint")}
      </Typography>
      {collectionSelected ? (
        <Button onClick={onCreateRequest} startIcon={<AddRoundedIcon />} variant="contained">
          {t("collectionsPage.newRequest")}
        </Button>
      ) : null}
    </Stack>
  );
}
