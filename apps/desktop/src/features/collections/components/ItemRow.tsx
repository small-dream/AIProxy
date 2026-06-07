import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { DropPosition } from "./dnd-helpers";
import { itemDndId } from "./CollectionTreeNodeView";

export function ItemRow({
  deleteLabel,
  depth,
  itemId,
  name,
  onContextMenu,
  onClick,
  onDelete,
  overId,
  overPosition,
  selected,
}: {
  deleteLabel: string;
  depth: number;
  itemId: string;
  name: string;
  onContextMenu: (event: ReactMouseEvent) => void;
  onClick: () => void;
  onDelete: () => void;
  overId: string | null;
  overPosition: DropPosition | null;
  selected: boolean;
}) {
  const dndId = itemDndId(itemId);
  const draggable = useDraggable({ id: dndId });
  const droppable = useDroppable({ id: dndId });

  const dropActive = droppable.isOver && overId === dndId;
  const dropBefore = dropActive && overPosition === "before";
  const dropAfter = dropActive && overPosition === "after";
  const indentPx = 8 + depth * 12;
  const isDragging = draggable.isDragging;

  return (
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
        className="collection-item-row"
        direction="row"
        onClick={onClick}
        onContextMenu={onContextMenu}
        sx={(theme) => ({
          alignItems: "center",
          borderRadius: 1,
          cursor: "pointer",
          gap: 0.75,
          mx: 0.75,
          opacity: isDragging ? 0.4 : 1,
          pl: 1 + depth * 1.5,
          pr: 0.5,
          py: 0.6,
          transition: "background-color 140ms ease",
          bgcolor: selected
            ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.09)
            : "transparent",
          "&:hover": {
            bgcolor: selected
              ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.12)
              : "action.hover",
          },
        })}
      >
        <ArticleRoundedIcon
          sx={{
            color: selected ? "primary.main" : "text.secondary",
            flex: "0 0 auto",
            fontSize: 15,
            opacity: selected ? 1 : 0.72,
          }}
        />
        <Typography
          noWrap
          sx={{
            flex: 1,
            fontSize: 12.75,
            fontWeight: selected ? 700 : 500,
            minWidth: 0,
          }}
        >
          {name}
        </Typography>
        <Tooltip title={deleteLabel}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            sx={{ opacity: 0, p: 0.5, ".collection-item-row:hover &": { opacity: 1 } }}
          >
            <DeleteRoundedIcon sx={{ fontSize: 16 }} />
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
  );
}
