import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDropDownRoundedIcon from "@mui/icons-material/ArrowDropDownRounded";
import ArrowRightRoundedIcon from "@mui/icons-material/ArrowRightRounded";
import CreateNewFolderRoundedIcon from "@mui/icons-material/CreateNewFolderRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import NoteAddRoundedIcon from "@mui/icons-material/NoteAddRounded";
import {
  Box,
  CircularProgress,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import type { CollectionTreeNode } from "@/features/collections/use-collections";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "@/features/sessions/components/context-menu.styles";
import type { TranslationKey } from "@/i18n";

import type { DropPosition } from "./dnd-helpers";
import { ItemRow } from "./ItemRow";
import type { CollectionEditorItem, RenameTarget } from "./tree-types";

const FOLDER_DRAG_PREFIX = "folder:";
const ITEM_DRAG_PREFIX = "item:";

export function folderDndId(id: string): string {
  return `${FOLDER_DRAG_PREFIX}${id}`;
}

export function itemDndId(id: string): string {
  return `${ITEM_DRAG_PREFIX}${id}`;
}

export function parseDndId(dndId: string): { kind: "folder" | "item"; id: string } | null {
  if (dndId.startsWith(FOLDER_DRAG_PREFIX)) {
    return { kind: "folder", id: dndId.slice(FOLDER_DRAG_PREFIX.length) };
  }
  if (dndId.startsWith(ITEM_DRAG_PREFIX)) {
    return { kind: "item", id: dndId.slice(ITEM_DRAG_PREFIX.length) };
  }
  return null;
}

type CollectionTreeNodeViewProps = {
  depth: number;
  deleteItemLabel: string;
  isFolderExpanded: (id: string) => boolean;
  isItemsLoading: boolean;
  node: CollectionTreeNode;
  onAddChild: (parentId: string) => void;
  onContextMenu: (event: ReactMouseEvent, target: RenameTarget) => void;
  onDelete: (id: string) => void;
  onDeleteItem: (item: CollectionEditorItem) => void;
  onNewRequest: (collectionId?: string | null) => void;
  onSelect: (id: string) => void;
  onSelectItem: (item: CollectionEditorItem) => void;
  onToggleExpand: (id: string, expanded: boolean) => void;
  overId: string | null;
  overPosition: DropPosition | null;
  selectedCollectionItems: CollectionEditorItem[];
  selectedCollectionId: string | null;
  selectedItemId: string | null;
  t: (key: TranslationKey) => string;
};

export function CollectionTreeNodeView(props: CollectionTreeNodeViewProps) {
  const {
    depth,
    deleteItemLabel,
    isFolderExpanded,
    isItemsLoading,
    node,
    onAddChild,
    onContextMenu,
    onDelete,
    onDeleteItem,
    onNewRequest,
    onSelect,
    onSelectItem,
    onToggleExpand,
    overId,
    overPosition,
    selectedCollectionItems,
    selectedCollectionId,
    selectedItemId,
    t,
  } = props;

  const dndId = folderDndId(node.id);
  const draggable = useDraggable({ id: dndId });
  const droppable = useDroppable({ id: dndId });
  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);
  const theme = useTheme();

  const isExpanded = isFolderExpanded(node.id);
  const selected = node.id === selectedCollectionId;
  const dropActive = droppable.isOver && overId === dndId;
  const dropBefore = dropActive && overPosition === "before";
  const dropInto = dropActive && overPosition === "into";
  const dropAfter = dropActive && overPosition === "after";
  const indentPx = 8 + depth * 12;
  const isDragging = draggable.isDragging;

  return (
    <Box>
      <Box
        ref={(el: HTMLDivElement | null) => {
          droppable.setNodeRef(el);
        }}
        sx={{ position: "relative" }}
      >
        {dropBefore ? (
          <Box
            aria-hidden
            sx={(theme) => ({
              position: "absolute",
              top: -1,
              left: indentPx,
              right: 8,
              height: 2,
              bgcolor: theme.palette.primary.main,
              borderRadius: 1,
              pointerEvents: "none",
              zIndex: 1,
            })}
          />
        ) : null}
        <Stack
          ref={(el: HTMLDivElement | null) => {
            draggable.setNodeRef(el);
          }}
          {...draggable.listeners}
          {...draggable.attributes}
          className="collection-row"
          direction="row"
          onClick={() => {
            onSelect(node.id);
            if (!isExpanded) onToggleExpand(node.id, true);
          }}
          onContextMenu={(event) =>
            onContextMenu(event, {
              kind: "collection",
              id: node.id,
              name: node.name,
              parentId: node.parentId,
            })
          }
          sx={(theme) => ({
            alignItems: "center",
            borderRadius: 1,
            color: selected ? "primary.main" : "text.primary",
            cursor: "pointer",
            gap: 0.75,
            mx: 0.75,
            opacity: isDragging ? 0.4 : 1,
            pl: 1 + depth * 1.5,
            pr: 0.5,
            py: 0.7,
            transition: "background-color 140ms ease, color 140ms ease",
            bgcolor: dropInto
              ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.16)
              : selected
                ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.09)
                : "transparent",
            "&:hover": {
              bgcolor: dropInto
                ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.16)
                : selected
                  ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.12)
                  : "action.hover",
            },
          })}
        >
          <Box
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(node.id, !isExpanded);
            }}
            sx={{
              alignItems: "center",
              color: "text.secondary",
              cursor: "pointer",
              display: "flex",
              flex: "0 0 auto",
              justifyContent: "center",
              width: 16,
              "&:hover": { color: "text.primary" },
            }}
          >
            {isExpanded ? (
              <ArrowDropDownRoundedIcon sx={{ fontSize: 18 }} />
            ) : (
              <ArrowRightRoundedIcon sx={{ fontSize: 18 }} />
            )}
          </Box>
          <Typography
            sx={{
              flex: 1,
              fontSize: 12.5,
              fontWeight: selected || !node.parentId ? 700 : 500,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.name}
          </Typography>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setAddMenuAnchor(e.currentTarget);
            }}
            sx={{ opacity: 0, p: 0.35, ".collection-row:hover &": { opacity: 1 } }}
          >
            <AddRoundedIcon sx={{ fontSize: 15 }} />
          </IconButton>
          <Menu
            anchorEl={addMenuAnchor}
            open={Boolean(addMenuAnchor)}
            onClose={() => setAddMenuAnchor(null)}
            onClick={(e) => e.stopPropagation()}
            slotProps={buildContextMenuSlotProps(168)}
          >
            <MenuItem
              onClick={() => {
                setAddMenuAnchor(null);
                onNewRequest(node.id);
              }}
              sx={getContextMenuItemSx(theme)}
            >
              <ListItemIcon sx={getContextMenuIconSx(theme)}>
                <NoteAddRoundedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText {...contextMenuItemTextProps}>
                {t("collectionsPage.newRequest")}
              </ListItemText>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setAddMenuAnchor(null);
                onAddChild(node.id);
              }}
              sx={getContextMenuItemSx(theme)}
            >
              <ListItemIcon sx={getContextMenuIconSx(theme)}>
                <CreateNewFolderRoundedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText {...contextMenuItemTextProps}>
                {t("collectionsPage.newFolder")}
              </ListItemText>
            </MenuItem>
          </Menu>
          <Tooltip title={t("collectionsPage.deleteCollection")}>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.id);
              }}
              sx={{ opacity: 0, p: 0.35, ".collection-row:hover &": { opacity: 1 } }}
            >
              <DeleteRoundedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Stack>
        {dropAfter ? (
          <Box
            aria-hidden
            sx={(theme) => ({
              position: "absolute",
              top: "calc(100% - 1px)",
              left: indentPx,
              right: 8,
              height: 2,
              bgcolor: theme.palette.primary.main,
              borderRadius: 1,
              pointerEvents: "none",
              zIndex: 1,
            })}
          />
        ) : null}
      </Box>
      {isExpanded ? (
        <>
          {node.children.map((child) => (
            <CollectionTreeNodeView
              key={child.id}
              depth={depth + 1}
              deleteItemLabel={deleteItemLabel}
              isFolderExpanded={isFolderExpanded}
              isItemsLoading={isItemsLoading}
              node={child}
              onAddChild={onAddChild}
              onContextMenu={onContextMenu}
              onDelete={onDelete}
              onDeleteItem={onDeleteItem}
              onNewRequest={onNewRequest}
              onSelect={onSelect}
              onSelectItem={onSelectItem}
              onToggleExpand={onToggleExpand}
              overId={overId}
              overPosition={overPosition}
              selectedCollectionId={selectedCollectionId}
              selectedCollectionItems={selectedCollectionItems}
              selectedItemId={selectedItemId}
              t={t}
            />
          ))}
          {selected && (isItemsLoading || selectedCollectionItems.length > 0) ? (
            <Box sx={{ py: 0.125 }}>
              {isItemsLoading ? (
                <Stack
                  sx={{
                    alignItems: "center",
                    py: 1.25,
                  }}
                >
                  <CircularProgress size={16} />
                </Stack>
              ) : (
                selectedCollectionItems.map((item) => (
                  <ItemRow
                    key={item.id}
                    deleteLabel={deleteItemLabel}
                    depth={depth + 1}
                    name={item.name}
                    onContextMenu={(event) => onContextMenu(event, { kind: "item", item })}
                    onClick={() => onSelectItem(item)}
                    onDelete={() => onDeleteItem(item)}
                    overId={overId}
                    overPosition={overPosition}
                    selected={item.id === selectedItemId}
                    itemId={item.id}
                  />
                ))
              )}
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
