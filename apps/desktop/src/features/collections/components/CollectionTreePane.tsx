import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { DndContext, pointerWithin } from "@dnd-kit/core";
import AccountTreeRoundedIcon from "@mui/icons-material/AccountTreeRounded";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import CreateNewFolderRoundedIcon from "@mui/icons-material/CreateNewFolderRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import {
  Alert,
  Box,
  Divider,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type React from "react";

import type { ApiCollectionItem } from "@aiproxy/shared-types";

import { CollectionTreeNodeView } from "@/features/collections/components/CollectionTreeNodeView";
import { EmptyPaneState, LoadingState } from "@/features/collections/components/PaneStates";
import { PaneHeader } from "@/features/collections/components/PaneHeader";
import { SearchInput } from "@/features/collections/components/SearchInput";
import { WorkbenchPane } from "@/features/collections/components/WorkbenchPane";
import type { CollectionEditorItem, RenameTarget } from "@/features/collections/components/tree-types";
import type { CollectionTreeNode } from "@/features/collections/use-collections";
import type { DropPosition } from "@/features/collections/components/dnd-helpers";
import type { TranslationKey, TranslationParams } from "@/i18n";

export interface CollectionTreePaneProps {
  // Data
  filteredTree: CollectionTreeNode[];
  collectionCount: number;
  items: ApiCollectionItem[];
  isCollectionsLoading: boolean;
  isItemsLoading: boolean;

  // Selection
  selectedCollectionId: string | null;
  selectedItemId: string | null;
  collectionFilter: string;

  // DnD
  dndSensors: ReturnType<typeof import("@dnd-kit/core").useSensors>;
  dropTarget: { overDndId: string; position: DropPosition } | null;

  // Tree state
  isFolderExpanded: (id: string) => boolean;

  // Environment
  activeEnvironmentId: string | null;
  environments: { id: string; name: string }[];
  hasEnvError: boolean;

  // Callbacks
  onCollectionFilterChange: (filter: string) => void;
  onSelectCollection: (id: string) => void;
  onSelectItem: (item: CollectionEditorItem) => void;
  onNewCollection: () => void;
  onAddChildFolder: (parentId: string) => void;
  onDeleteCollection: (id: string) => void;
  onDeleteItem: (item: CollectionEditorItem) => void;
  onNewRequest: (collectionId?: string | null) => void;
  onToggleExpand: (id: string, expanded: boolean) => void;
  onContextMenu: (event: React.MouseEvent, target: RenameTarget) => void;
  onDragStart: (event: DragStartEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
  onEnvironmentChange: (id: string | null) => void;
  onManageEnvironments: () => void;

  // i18n
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

export function CollectionTreePane({
  filteredTree,
  collectionCount,
  items,
  isCollectionsLoading,
  isItemsLoading,
  selectedCollectionId,
  selectedItemId,
  collectionFilter,
  dndSensors,
  dropTarget,
  isFolderExpanded,
  activeEnvironmentId,
  environments,
  hasEnvError,
  onCollectionFilterChange,
  onSelectCollection,
  onSelectItem,
  onNewCollection,
  onAddChildFolder,
  onDeleteCollection,
  onDeleteItem,
  onNewRequest,
  onToggleExpand,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  onEnvironmentChange,
  onManageEnvironments,
  t,
}: CollectionTreePaneProps) {
  return (
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
        actions={
          <Tooltip title={t("collectionsPage.newCollection")}>
            <IconButton size="small" onClick={onNewCollection}>
              <CreateNewFolderRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        }
      />
      <Box sx={{ px: 1.25, pb: 1 }}>
        <SearchInput
          onChange={onCollectionFilterChange}
          placeholder={t("collectionsPage.searchCollections")}
          value={collectionFilter}
        />
      </Box>
      <Divider />

      <Box sx={{ flex: "1 1 0", minHeight: 0, overflow: "auto", py: 0.625 }}>
        {isCollectionsLoading ? (
          <LoadingState />
        ) : filteredTree.length > 0 ? (
          <DndContext
            collisionDetection={pointerWithin}
            sensors={dndSensors}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            {filteredTree.map((node) => (
              <CollectionTreeNodeView
                key={node.id}
                depth={0}
                deleteItemLabel={t("collectionsPage.deleteItem")}
                isFolderExpanded={isFolderExpanded}
                isItemsLoading={isItemsLoading}
                node={node}
                onAddChild={onAddChildFolder}
                onContextMenu={onContextMenu}
                onDelete={onDeleteCollection}
                onDeleteItem={onDeleteItem}
                onNewRequest={onNewRequest}
                onSelect={onSelectCollection}
                onSelectItem={onSelectItem}
                onToggleExpand={onToggleExpand}
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
            onAction={onNewCollection}
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
            bgcolor: alpha(
              theme.palette.primary.main,
              theme.palette.mode === "dark" ? 0.1 : 0.06,
            ),
            border: 1,
            borderColor: alpha(
              theme.palette.primary.main,
              theme.palette.mode === "dark" ? 0.22 : 0.16,
            ),
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
            onChange={(e) => onEnvironmentChange(e.target.value || null)}
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
            {environments.map((env) => (
              <MenuItem key={env.id} value={env.id}>
                {env.name}
              </MenuItem>
            ))}
          </Select>
          <Tooltip title={t("collectionsPage.manageEnvironments")}>
            <IconButton
              size="small"
              onClick={onManageEnvironments}
              sx={{ color: "text.secondary", flex: "0 0 auto" }}
            >
              <SettingsRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        {hasEnvError && (
          <Alert severity="warning" sx={{ mt: 0.5, py: 0 }}>
            {t("common.errors.generic")}
          </Alert>
        )}
      </Box>
    </WorkbenchPane>
  );
}
