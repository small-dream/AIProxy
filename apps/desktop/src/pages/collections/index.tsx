import DriveFileRenameOutlineRoundedIcon from "@mui/icons-material/DriveFileRenameOutlineRounded";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  TextField,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ApiCollectionItem } from "@aiproxy/shared-types";

import { encodeComposedRequest } from "@/features/compose/encode-request";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { useCollectionEditorStore } from "@/features/collections/collection-editor.store";
import {
  clampExplorerWidth,
  EXPLORER_WIDTH_STORAGE_KEY,
  INSPECTOR_SPLIT_RATIO_STORAGE_KEY,
  REQUEST_COLLAPSED_STORAGE_KEY,
} from "@/features/collections/collections-layout.helpers";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  readActiveEnvironmentId,
  writeActiveEnvironmentId,
} from "@/features/environments/active-environment";
import { CollectionEditorPane } from "@/features/collections/components/CollectionEditorPane";
import { CollectionTreePane } from "@/features/collections/components/CollectionTreePane";
import type { CollectionEditorItem } from "@/features/collections/components/tree-types";
import {
  useCollectionItems,
  useDeleteCollectionItem,
  useMoveCollectionItem,
  useUpsertCollectionItem,
} from "@/features/collections/use-collection-items";
import {
  buildCollectionTree,
  useCollections,
  useDeleteCollection,
  useMoveCollection,
  useUpsertCollection,
} from "@/features/collections/use-collections";
import { useCollectionTree } from "@/features/collections/use-collection-tree";
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
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "@/features/sessions/components/context-menu.styles";
import { readStorageValue, writeStorageValue } from "@/features/sessions/session-ui.helpers";
import { useI18n } from "@/i18n";

export function CollectionsPage() {
  const { t } = useI18n();
  const theme = useTheme();

  // --- Data queries ---

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

  // --- Editor ---

  const editor = useCollectionEditorStore();
  const sendMutation = useSendComposedRequest();
  const upsertItemMutation = useUpsertCollectionItem();
  const deleteItemMutation = useDeleteCollectionItem();

  // --- Layout state ---

  const explorerDragFrameRef = useRef<number | null>(null);
  const inspectorDragFrameRef = useRef<number | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const parsedWidth = Number(readStorageValue(EXPLORER_WIDTH_STORAGE_KEY));
    return Number.isFinite(parsedWidth) ? clampExplorerWidth(parsedWidth) : 320;
  });
  const [inspectorSplitRatio, setInspectorSplitRatio] = useState(() => {
    const parsedRatio = Number(readStorageValue(INSPECTOR_SPLIT_RATIO_STORAGE_KEY));
    return Number.isFinite(parsedRatio)
      ? clampInspectorSplitRatio(parsedRatio)
      : DEFAULT_REQUEST_SPLIT_RATIO;
  });
  const [requestCollapsed, setRequestCollapsed] = useState(
    () => readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
  );
  const [requestTab, setRequestTab] = useState<"headers" | "body" | "query">("headers");
  const [responseTab, setResponseTab] =
    useState<import("@/features/compose/components/ComposeResponseSection").ComposeResponseTab>(
      "overview",
    );

  // --- Environment ---

  const environmentsQuery = useEnvironments();
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(() => {
    return readActiveEnvironmentId();
  });
  const envVarsQuery = useEnvironmentVariables(activeEnvironmentId);
  const globalVarsQuery = useGlobalVariables();
  const mergedVarMap = useMemo(
    () => buildMergedVariableMap(envVarsQuery.data ?? [], globalVarsQuery.data ?? []),
    [envVarsQuery.data, globalVarsQuery.data],
  );

  // --- Dialog state ---

  const [newCollectionDialogOpen, setNewCollectionDialogOpen] = useState(false);
  const [newCollectionParentId, setNewCollectionParentId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [manageEnvDialogOpen, setManageEnvDialogOpen] = useState(false);
  // Destructive deletes are confirmed first; the target drives the dialog copy.
  const [deleteCollectionConfirm, setDeleteCollectionConfirm] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteItemConfirm, setDeleteItemConfirm] = useState<CollectionEditorItem | null>(null);

  // --- Tree hook (DnD, context menu, rename, expansion) ---

  const moveCollection = useMoveCollection();
  const moveCollectionItem = useMoveCollectionItem();

  const treeHook = useCollectionTree({
    collections,
    items,
    tree,
    selectedCollectionId,
    selectedItemId,
    collectionFilter,
    upsertCollection,
    deleteCollection: deleteCollectionMutation,
    moveCollection,
    upsertItem: upsertItemMutation,
    deleteItem: deleteItemMutation,
    moveItem: moveCollectionItem,
    editor,
    setSelectedCollectionId,
    setSelectedItemId,
    t,
  });

  // --- Persist layout state ---

  useEffect(() => {
    writeActiveEnvironmentId(activeEnvironmentId);
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

  // --- Editor handlers ---

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
    const {
      multipartEntries,
      textBody: encodedBody,
      headers: finalHeaders,
    } = encodeComposedRequest(
      {
        headers: editor.headers,
        body: editor.body,
        bodyType: editor.bodyType,
        formFiles: editor.formFiles,
        rawLanguage: editor.rawLanguage,
        formDataEntries: editor.formDataEntries,
        urlEncodedEntries: editor.urlEncodedEntries,
      },
      mergedVarMap,
    );

    sendMutation.mutate({
      workspaceId: "default",
      method: editor.method,
      url: substitutedUrl,
      headers: finalHeaders,
      ...(encodedBody !== undefined ? { body: encodedBody } : {}),
      ...(multipartEntries && multipartEntries.length > 0 ? { multipartEntries } : {}),
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
        formFiles: editor.formFiles,
        headers: editor.headers,
        method: editor.method,
        name: editor.name || `${editor.method} ${editor.url}`,
        rawLanguage: editor.rawLanguage,
        url: editor.url,
        urlEncoded: editor.urlEncodedEntries,
      },
      {
        onSuccess: (item: ApiCollectionItem) => {
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

  // --- Resize handlers ---

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

  const startInspectorResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [requestCollapsed],
  );

  // --- Render ---

  const hasEnvError = environmentsQuery.isError || envVarsQuery.isError || globalVarsQuery.isError;

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
      <CollectionTreePane
        activeEnvironmentId={activeEnvironmentId}
        collectionCount={treeHook.collectionCount}
        collectionFilter={collectionFilter}
        dndSensors={treeHook.dndSensors}
        dropTarget={treeHook.dropTarget}
        environments={environmentsQuery.data ?? []}
        filteredTree={treeHook.filteredTree}
        hasEnvError={hasEnvError}
        isCollectionsLoading={collectionsQuery.isLoading}
        isFolderExpanded={treeHook.isFolderExpanded}
        isItemsLoading={itemsQuery.isLoading}
        items={items}
        onAddChildFolder={(parentId) => {
          setNewCollectionParentId(parentId);
          setNewCollectionDialogOpen(true);
        }}
        onCollectionFilterChange={setCollectionFilter}
        onContextMenu={treeHook.handleTreeContextMenu}
        onDragCancel={treeHook.handleDragCancel}
        onDragEnd={treeHook.handleDragEnd}
        onDragOver={treeHook.handleDragOver}
        onDragStart={treeHook.handleDragStart}
        onEnvironmentChange={setActiveEnvironmentId}
        onManageEnvironments={() => setManageEnvDialogOpen(true)}
        onNewCollection={() => {
          setNewCollectionParentId(null);
          setNewCollectionDialogOpen(true);
        }}
        onNewRequest={handleCreateRequest}
        onSelectCollection={handleSelectCollection}
        onSelectItem={handleSelectItem}
        onDeleteCollection={(id) =>
          setDeleteCollectionConfirm({
            id,
            name: collections.find((collection) => collection.id === id)?.name ?? "",
          })
        }
        onDeleteItem={(item) => setDeleteItemConfirm(item)}
        onToggleExpand={treeHook.handleToggleExpand}
        selectedCollectionId={selectedCollectionId}
        selectedItemId={selectedItemId}
        t={t}
      />

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
            bgcolor: (theme) =>
              alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
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

      <CollectionEditorPane
        collectionId={editor.collectionId}
        collectionSelected={Boolean(selectedCollectionId)}
        editor={editor}
        hasEnvError={hasEnvError}
        inspectorSplitRatio={inspectorSplitRatio}
        onCreateRequest={() => handleCreateRequest()}
        onInspectorResizeStart={startInspectorResize}
        onRequestCollapsedChange={setRequestCollapsed}
        onRequestTabChange={setRequestTab}
        onResponseTabChange={setResponseTab}
        onSave={handleSave}
        onSend={handleSend}
        requestCollapsed={requestCollapsed}
        requestTab={requestTab}
        responseDetail={sendMutation.data}
        responseTab={responseTab}
        sendError={sendMutation.isError}
        sendErrorMessage={sendMutation.error?.message}
        sendPending={sendMutation.isPending}
        t={t}
        upsertPending={upsertItemMutation.isPending}
      />

      <Menu
        anchorPosition={
          treeHook.treeMenuState
            ? { left: treeHook.treeMenuState.mouseX, top: treeHook.treeMenuState.mouseY }
            : undefined
        }
        anchorReference="anchorPosition"
        onClose={treeHook.handleTreeMenuClose}
        open={Boolean(treeHook.treeMenuState)}
        slotProps={buildContextMenuSlotProps(160)}
      >
        <MenuItem onClick={treeHook.handleBeginRename} sx={getContextMenuItemSx(theme)}>
          <ListItemIcon sx={getContextMenuIconSx(theme)}>
            <DriveFileRenameOutlineRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("collectionsPage.rename")}</ListItemText>
        </MenuItem>
      </Menu>

      <Dialog
        fullWidth
        maxWidth="xs"
        open={newCollectionDialogOpen}
        onClose={() => setNewCollectionDialogOpen(false)}
      >
        <DialogTitle>
          {newCollectionParentId
            ? t("collectionsPage.newFolder")
            : t("collectionsPage.newCollection")}
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
        open={Boolean(treeHook.renameTarget)}
        onClose={treeHook.handleRenameCancel}
      >
        <DialogTitle>{t("collectionsPage.rename")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={
              treeHook.renameTarget?.kind === "item"
                ? t("collectionsPage.requestName")
                : t("collectionsPage.namePlaceholder")
            }
            value={treeHook.renameName}
            onChange={(e) => treeHook.setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") treeHook.handleRenameSubmit();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={treeHook.handleRenameCancel}>{t("common.actions.cancel")}</Button>
          <Button
            disabled={!treeHook.renameName.trim()}
            onClick={treeHook.handleRenameSubmit}
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
        message={treeHook.moveError ?? ""}
        onClose={() => treeHook.setMoveError(null)}
        open={treeHook.moveError !== null}
      />

      <ConfirmDialog
        open={deleteCollectionConfirm !== null}
        title={t("collectionsPage.deleteCollectionTitle")}
        message={t("common.confirmDeleteMessage", {
          name: deleteCollectionConfirm?.name ?? "",
        })}
        onConfirm={() => {
          if (!deleteCollectionConfirm) return;
          treeHook.handleDeleteCollection(deleteCollectionConfirm.id);
          setDeleteCollectionConfirm(null);
        }}
        onCancel={() => setDeleteCollectionConfirm(null)}
        isConfirming={deleteCollectionMutation.isPending}
      />

      <ConfirmDialog
        open={deleteItemConfirm !== null}
        title={t("collectionsPage.deleteItemTitle")}
        message={t("common.confirmDeleteMessage", {
          name: deleteItemConfirm?.name ?? "",
        })}
        onConfirm={() => {
          if (!deleteItemConfirm) return;
          treeHook.handleDeleteItem(deleteItemConfirm);
          setDeleteItemConfirm(null);
        }}
        onCancel={() => setDeleteItemConfirm(null)}
        isConfirming={deleteItemMutation.isPending}
      />
    </Box>
  );
}
