import { type ReactNode } from "react";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import type { TranslationFn } from "@/features/rules/rules.helpers";
import { fontFamilies } from "@/themes/fonts";

export function formatRuleFieldLabel(
  label: string,
  requirement: "optional" | "required",
  t: TranslationFn,
) {
  const hint =
    requirement === "required"
      ? t("rulesPage.fieldHints.required")
      : t("rulesPage.fieldHints.optional");

  return `${label} (${hint})`;
}

/* ── FieldGroup ───────────────────────────────────────────────────── */

export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.5}>
      <Typography
        variant="subtitle2"
        sx={{
          color: "text.secondary",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/* ── InlineSwitch ─────────────────────────────────────────────────── */

export function InlineSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",

        bgcolor: (theme) =>
          alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.04 : 0.035),

        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        minHeight: 36,
        px: 1,
      }}
    >
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Switch size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Stack>
  );
}

/* ── RuleSection ─────────────────────────────────────────────────── */

export function RuleSection({ children }: { children: ReactNode }) {
  return (
    <Paper
      elevation={0}
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        p: 2,
        "& .MuiInputLabel-root.MuiInputLabel-shrink": {
          bgcolor: "background.paper",
          px: 0.5,
        },
      }}
    >
      {children}
    </Paper>
  );
}

/* ── ManagedRulesWorkbench ────────────────────────────────────────── */

export function ManagedRulesWorkbench(props: {
  /** Optional batch-action bar rendered above the rule list (R5). */
  batchBar?: ReactNode;
  createActions: ReactNode;
  editor: ReactNode;
  list: ReactNode;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchValue: string;
}) {
  const { batchBar, createActions, editor, list, onSearchChange, searchPlaceholder, searchValue } =
    props;

  return (
    <Box
      sx={{
        display: "grid",
        gap: 0,
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          lg: "340px 6px minmax(0, 1fr)",
          xl: "360px 6px minmax(0, 1fr)",
        },
        height: "100%",
        minHeight: 0,
      }}
    >
      <Paper
        elevation={0}
        sx={{
          alignSelf: "stretch",
          bgcolor: (theme) =>
            theme.palette.mode === "dark"
              ? alpha(theme.palette.background.default, 0.18)
              : alpha(theme.palette.background.default, 0.36),
          border: 0,
          borderColor: "divider",
          borderRadius: 0,
          borderBottom: { lg: 0, xs: 1 },
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: { xs: 280, lg: 0 },
          overflow: "hidden",
        }}
      >
        <Stack spacing={1.25} sx={{ borderBottom: 1, borderColor: "divider", p: 1.5 }}>
          <OutlinedInput
            size="small"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            startAdornment={
              <InputAdornment position="start">
                <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
              </InputAdornment>
            }
            sx={{
              bgcolor: "background.paper",
              fontSize: 13,
              height: 36,
            }}
          />
          <Stack
            direction="row"
            spacing={0.75}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            {createActions}
          </Stack>
          {batchBar}
        </Stack>

        <Box sx={{ flex: 1, minHeight: 220, overflow: "auto", p: 1 }}>{list}</Box>
      </Paper>
      <Box
        aria-hidden
        sx={{
          alignItems: "center",
          display: { lg: "flex", xs: "none" },
          justifyContent: "center",
          minHeight: 0,
          "&::before": {
            bgcolor: (theme) =>
              alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
            borderRadius: 999,
            content: '""',
            height: "100%",
            width: 1,
          },
        }}
      />
      <Paper
        elevation={0}
        sx={{
          bgcolor: "transparent",
          border: 0,
          borderColor: "divider",
          borderRadius: 0,
          height: "100%",
          minWidth: 0,
          overflow: "auto",
          p: 2,
        }}
      >
        {editor}
      </Paper>
    </Box>
  );
}

/* ── ManagedRuleList ──────────────────────────────────────────────── */

export type ManagedRuleListItem = {
  active: boolean;
  chipLabel: string;
  enabled: boolean;
  id: string;
  name: string;
  onClick: () => void;
  /** When provided, renders a row-leading checkbox (multi-select, R5). */
  onSelectToggle?: () => void;
  /** When provided, renders an inline switch that persists immediately
   *  (via the caller's save mutation) instead of the static OFF chip. */
  onToggleEnabled?: (enabled: boolean) => void;
  subtitle: string;
};

export function ManagedRuleList(props: {
  emptyDescription: string;
  items: ManagedRuleListItem[];
  /** When provided, the list becomes sortable and reports the new order. */
  onReorder?: (orderedIds: string[]) => void;
  /** Ids currently selected via the row checkboxes. */
  selectedIds?: Set<string>;
}) {
  const { emptyDescription, items, onReorder, selectedIds } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  if (items.length === 0) {
    return (
      <Box
        sx={{
          alignItems: "center",
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          color: "text.secondary",
          display: "flex",
          minHeight: 180,
          px: 2,
          textAlign: "center",
        }}
      >
        <Typography variant="body2" sx={{ fontSize: 13 }}>
          {emptyDescription}
        </Typography>
      </Box>
    );
  }

  const content = (
    <List disablePadding dense sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {items.map((item) => (
        <ManagedRuleListRow
          key={item.id}
          item={item}
          onReorder={onReorder}
          selected={selectedIds?.has(item.id) ?? false}
        />
      ))}
    </List>
  );

  if (!onReorder) {
    return content;
  }

  return (
    <DndContext
      collisionDetection={closestCenter}
      sensors={sensors}
      onDragEnd={(event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        if (oldIndex < 0 || newIndex < 0) return;
        onReorder(
          arrayMove(
            items.map((item) => item.id),
            oldIndex,
            newIndex,
          ),
        );
      }}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {content}
      </SortableContext>
    </DndContext>
  );
}

function ManagedRuleListRow({
  item,
  onReorder,
  selected,
}: {
  item: ManagedRuleListItem;
  onReorder?: ((orderedIds: string[]) => void) | undefined;
  selected: boolean;
}) {
  const { t } = useI18n();
  const sortable = useSortable({ id: item.id, disabled: !onReorder });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  return (
    <ListItemButton
      ref={setNodeRef}
      selected={item.active}
      onClick={item.onClick}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      sx={{
        border: 1,
        borderColor: item.active ? "primary.main" : "divider",
        borderRadius: "8px",
        opacity: isDragging ? 0.55 : 1,
        overflow: "hidden",
        px: 1.25,
        py: 1,
        ...(onReorder ? { cursor: "default" } : {}),
        "&.Mui-selected": {
          bgcolor: (theme) =>
            alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.08),
        },
        "&:hover": {
          bgcolor: (theme) =>
            alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.13 : 0.055),
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.45),
        },
      }}
    >
      {item.onSelectToggle && (
        <Checkbox
          size="small"
          checked={selected}
          onChange={(event) => {
            event.stopPropagation();
            item.onSelectToggle?.();
          }}
          onClick={(event) => event.stopPropagation()}
          slotProps={{ input: { "aria-label": `select ${item.name}` } }}
          sx={{ ml: -0.5, mr: 0.25 }}
        />
      )}
      {onReorder && (
        <Box
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          sx={{
            alignItems: "center",
            color: "text.disabled",
            cursor: "grab",
            display: "flex",
            mr: 0.25,
            touchAction: "none",
          }}
          aria-label={t("rulesPage.batch.dragHandle")}
        >
          <DragIndicatorRoundedIcon fontSize="small" />
        </Box>
      )}
      <ListItemText
        primary={
          <Stack
            direction="row"
            spacing={1}
            sx={{
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 650, fontSize: 13 }} noWrap>
              {item.name}
            </Typography>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {item.onToggleEnabled ? (
                <Switch
                  size="small"
                  checked={item.enabled}
                  onChange={(event) => {
                    event.stopPropagation();
                    item.onToggleEnabled?.(event.target.checked);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  slotProps={{ input: { "aria-label": item.name } }}
                />
              ) : (
                !item.enabled && (
                  <Chip
                    size="small"
                    label={t("rulesPage.off")}
                    variant="outlined"
                    sx={{ height: 20, fontSize: 11 }}
                  />
                )
              )}
              <Chip
                size="small"
                label={item.chipLabel}
                variant={item.active ? "filled" : "outlined"}
                sx={{
                  fontFamily: fontFamilies.mono,
                  fontSize: 11,
                  height: 20,
                }}
              />
            </Stack>
          </Stack>
        }
        secondary={
          <Typography
            variant="caption"
            noWrap
            component="p"
            sx={{
              color: "text.secondary",
              mt: 0.35,
            }}
          >
            {item.subtitle}
          </Typography>
        }
      />
    </ListItemButton>
  );
}

/* ── Batch action bar (multi-select, R5) ─────────────────────────── */

export function RuleBatchBar(props: {
  count: number;
  deletePending: boolean;
  onDelete: () => void;
  onDisable: () => void;
  onDone: () => void;
  onEnable: () => void;
}) {
  const { t } = useI18n();
  const { count, deletePending, onDelete, onDisable, onDone, onEnable } = props;

  return (
    <Box
      sx={{
        alignItems: "center",
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
        border: 1,
        borderColor: (theme) => alpha(theme.palette.primary.main, 0.35),
        borderRadius: "8px",
        display: "flex",
        gap: 0.75,
        px: 1,
        py: 0.5,
        flexWrap: "wrap",
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 650, fontSize: 13, mr: 0.5 }}>
        {t("rulesPage.batch.selectedCount", { count })}
      </Typography>
      <Button size="small" variant="outlined" onClick={onEnable}>
        {t("rulesPage.batch.enable")}
      </Button>
      <Button size="small" variant="outlined" onClick={onDisable}>
        {t("rulesPage.batch.disable")}
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="error"
        onClick={onDelete}
        disabled={deletePending}
      >
        {t("rulesPage.batch.delete")}
      </Button>
      <Button size="small" onClick={onDone}>
        {t("rulesPage.batch.done")}
      </Button>
    </Box>
  );
}
