import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import DragIndicatorRoundedIcon from "@mui/icons-material/DragIndicatorRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
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
  Collapse,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";

import { isMacPlatform } from "@/components/layout/hooks/helpers";
import { useI18n } from "@/i18n";
import type { TranslationFn } from "@/features/rules/rules.helpers";
import { PriorityField } from "@/features/rules/components/PriorityField";
import { moveRuleInOrder } from "@/features/rules/rules-priority.helpers";
import { fontFamilies } from "@/themes/fonts";

/** Platform-aware glyph for the reorder accelerator (⌥ on macOS, Alt elsewhere). */
export function reorderShortcutLabel() {
  return isMacPlatform() ? "⌥↑/↓" : "Alt+↑/↓";
}

/** Page-level shortcuts must not fire while the user is typing in a field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[role="textbox"], [role="combobox"]') !== null;
}

export function formatRuleFieldLabel(
  label: string,
  requirement: "optional" | "required",
  t: TranslationFn,
) {
  // Label discipline: required is the default state of a form field and carries
  // no suffix; only genuinely optional fields are marked.
  if (requirement === "required") return label;

  return `${label} (${t("rulesPage.fieldHints.optional")})`;
}

/**
 * A failed write keeps its `error` until the next `mutate`, so switching to
 * another rule would leave a stale alert describing the previous one. Clears
 * the error only when the editor actually moves to a different rule — a fresh
 * failure must stay visible.
 */
export function useClearMutationErrorOnRuleChange(
  mutation: { isError: boolean; reset: () => void },
  selectedRuleId: string | undefined,
) {
  const { isError, reset } = mutation;
  const previousRuleIdRef = useRef(selectedRuleId);
  useEffect(() => {
    const selectionChanged = previousRuleIdRef.current !== selectedRuleId;
    previousRuleIdRef.current = selectedRuleId;
    if (selectionChanged && isError) reset();
  }, [isError, reset, selectedRuleId]);
}

/* ── FieldGroup ───────────────────────────────────────────────────── */

export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.5}>
      <Typography
        variant="subtitle2"
        sx={{
          color: "text.primary",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.4,
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

/* ── Editor status / action bars ──────────────────────────────────── */

/**
 * Editor identity row, shared by every managed-rule workbench (breakpoint /
 * rewrite / map / dns / script): rule name + Enabled switch on a tinted card,
 * with the raw priority number tucked into a collapsed "Advanced" disclosure
 * (list order IS the priority; the number is an escape hatch). Save/Remove
 * live in the EditorActionBar footer, not here.
 *
 * The name field and the Advanced disclosure are both optional: breakpoint
 * rules have no name and no numeric priority in the data model, so that panel
 * renders only the Enabled switch (plus an optional scope hint).
 */
export function RuleEditorIdentity(props: {
  /** Content of the collapsed Advanced disclosure (typically a PriorityField).
   *  When omitted, the disclosure is not rendered at all. */
  advanced?: ReactNode;
  advancedOpen?: boolean;
  enabled: boolean;
  /** Optional scope hint rendered below the identity row (e.g. "applies to
   *  all traffic" for a catch-all pattern). */
  hint?: string | undefined;
  /** Rule name value; the name field renders only when `onNameChange` is
   *  provided (breakpoint rules have no name field). */
  name?: string;
  /** Field-level validation props from ruleFieldProps (error/helperText). */
  nameFieldProps?: { error: boolean; helperText?: string } | undefined;
  onNameChange?: ((name: string) => void) | undefined;
  onToggleAdvanced?: (() => void) | undefined;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const {
    advanced,
    advancedOpen = false,
    enabled,
    hint,
    name,
    nameFieldProps,
    onNameChange,
    onToggleAdvanced,
    onToggleEnabled,
  } = props;
  // Per-instance id: a panel can mount more than one identity row, so a shared
  // hardcoded id would produce duplicate DOM ids and a broken label target.
  const enabledLabelId = useId();

  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.1 : 0.045),
        border: 1,
        borderColor: alpha(theme.palette.primary.main, 0.18),
        borderRadius: "8px",
        p: 1.5,
        "& .MuiInputLabel-root.MuiInputLabel-shrink": {
          bgcolor:
            theme.palette.mode === "dark"
              ? theme.palette.background.paper
              : theme.palette.background.default,
          px: 0.5,
        },
      })}
    >
      <Stack spacing={1}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.25}
          sx={{
            alignItems: { xs: "stretch", md: "center" },
          }}
        >
          {onNameChange && (
            <TextField
              size="small"
              label={t("rulesPage.editor.ruleName")}
              value={name ?? ""}
              onChange={(event) => onNameChange(event.target.value)}
              {...nameFieldProps}
              sx={{ flex: 1 }}
            />
          )}
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              alignItems: "center",
              border: 1,
              borderColor: "divider",
              borderRadius: "8px",
              minHeight: 40,
              px: 1,
            }}
          >
            <Typography
              variant="caption"
              id={enabledLabelId}
              sx={{
                color: "text.secondary",
              }}
            >
              {t("rulesPage.editor.enabled")}
            </Typography>
            <Switch
              size="small"
              checked={enabled}
              onChange={(event) => onToggleEnabled(event.target.checked)}
              slotProps={{ input: { "aria-labelledby": enabledLabelId } }}
            />
          </Stack>
        </Stack>
        {hint && (
          <Typography
            variant="caption"
            sx={{
              color: "warning.dark",
              fontWeight: 600,
            }}
          >
            {hint}
          </Typography>
        )}
        {advanced !== undefined && (
          <Box>
            <Button
              size="small"
              aria-expanded={advancedOpen}
              endIcon={
                <ExpandMoreRoundedIcon
                  fontSize="small"
                  sx={{
                    transform: advancedOpen ? "rotate(180deg)" : "none",
                    transition: "transform 120ms ease",
                  }}
                />
              }
              onClick={onToggleAdvanced}
              sx={{ color: "text.secondary", px: 0.5 }}
            >
              {t("rulesPage.editor.advanced")}
            </Button>
            <Collapse in={advancedOpen}>
              <Box sx={{ pt: 1 }}>{advanced}</Box>
            </Collapse>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

/** Shared priority input for the Advanced disclosure of RuleEditorIdentity. */
export function AdvancedPriorityField({
  onCommit,
  value,
}: {
  onCommit: (priority: number) => void;
  value: number;
}) {
  const { t } = useI18n();
  return (
    <PriorityField
      value={value}
      label={formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t)}
      onCommit={onCommit}
      sx={{ width: { xs: "100%", md: 200 } }}
    />
  );
}

/** Dirty-state indicator: colored dot + caption, announced as a status. */
export function UnsavedChangesIndicator({ label }: { label: string }) {
  return (
    <Stack direction="row" spacing={0.75} role="status" sx={{ alignItems: "center" }}>
      <Box
        aria-hidden
        sx={{
          bgcolor: "warning.main",
          borderRadius: "50%",
          flexShrink: 0,
          height: 8,
          width: 8,
        }}
      />
      <Typography variant="caption" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
        {label}
      </Typography>
    </Stack>
  );
}

/**
 * Fixed (non-scrolling) action bar for long editor forms: keeps the primary
 * action (Save) always visible. Passed to ManagedRulesWorkbench via the
 * editorFooter slot, which renders it as a sibling below the editor's scroll
 * area — no sticky positioning, so it can never overlap scrolling content.
 */
export function EditorActionBar({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        alignItems: "center",
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
        display: "flex",
        gap: 1,
        px: 2,
        py: 1,
      }}
    >
      {children}
    </Box>
  );
}

/* ── ManagedRulesWorkbench ────────────────────────────────────────── */

export function ManagedRulesWorkbench(props: {
  /** Optional batch-action bar rendered above the rule list (R5). */
  batchBar?: ReactNode;
  createActions: ReactNode;
  editor: ReactNode;
  /** Optional fixed action bar pinned below the editor scroll area (e.g.
   *  EditorActionBar with the primary Save action). Never overlaps content. */
  editorFooter?: ReactNode;
  list: ReactNode;
  /** When true (e.g. the rule list is empty), hides the search/create/batch
   *  header so the list's own empty state is the single call to action. */
  listControlsHidden?: boolean;
  /** Optional hint pinned below the list scroll area (e.g. reorder help). */
  listFooter?: ReactNode;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchValue: string;
}) {
  const {
    batchBar,
    createActions,
    editor,
    editorFooter,
    list,
    listControlsHidden = false,
    listFooter,
    onSearchChange,
    searchPlaceholder,
    searchValue,
  } = props;

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
        {listControlsHidden ? null : (
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
        )}

        <Box sx={{ flex: 1, minHeight: 220, overflow: "auto", p: 1 }}>{list}</Box>
        {listFooter && (
          <Box sx={{ borderTop: 1, borderColor: "divider", px: 1.5, py: 1 }}>{listFooter}</Box>
        )}
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
          display: "flex",
          flexDirection: "column",
          height: "100%",
          // Grid items default to min-height:auto, which would let a long form
          // grow the pane past the grid and hand scrolling to an outer
          // container.
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>{editor}</Box>
        {editorFooter}
      </Paper>
    </Box>
  );
}

/* ── ManagedRuleList ──────────────────────────────────────────────── */

export type ManagedRuleListItem = {
  active: boolean;
  /** Optional trailing chip (e.g. a priority number). Panels where list order
   *  IS the priority omit it so the number does not compete with drag order. */
  chipLabel?: string;
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
  /** Optional actions rendered inside the empty state (e.g. "New rule"). */
  emptyActions?: ReactNode;
  emptyDescription: string;
  items: ManagedRuleListItem[];
  /** When provided, the list becomes sortable and reports the new order. */
  onReorder?: (orderedIds: string[]) => void;
  /** Ids currently selected via the row checkboxes. */
  selectedIds?: Set<string>;
}) {
  const { emptyActions, emptyDescription, items, onReorder, selectedIds } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  if (items.length === 0) {
    return (
      <Stack
        spacing={1.5}
        sx={{
          alignItems: "center",
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          color: "text.secondary",
          display: "flex",
          justifyContent: "center",
          minHeight: 180,
          px: 2,
          py: 2.5,
          textAlign: "center",
        }}
      >
        <Typography variant="body2" sx={{ fontSize: 13 }}>
          {emptyDescription}
        </Typography>
        {emptyActions}
      </Stack>
    );
  }

  const orderedIds = items.map((item) => item.id);

  const content = (
    <List disablePadding dense sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {items.map((item) => (
        <ManagedRuleListRow
          key={item.id}
          item={item}
          onKeyboardMove={
            onReorder
              ? (direction) => {
                  const next = moveRuleInOrder(orderedIds, item.id, direction);
                  if (next) onReorder(next);
                }
              : undefined
          }
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
  onKeyboardMove,
  onReorder,
  selected,
}: {
  item: ManagedRuleListItem;
  /** Alt+ArrowUp/ArrowDown reorder, reported as a one-slot move of this row. */
  onKeyboardMove?: ((direction: -1 | 1) => void) | undefined;
  onReorder?: ((orderedIds: string[]) => void) | undefined;
  selected: boolean;
}) {
  const { t } = useI18n();
  const sortable = useSortable({ id: item.id, disabled: !onReorder });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  // Keyboard access to the two pointer-only interactions on this row:
  // ArrowUp/ArrowDown move focus between rows; Alt+ArrowUp/ArrowDown reorders.
  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (!onKeyboardMove) return;
      event.preventDefault();
      onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const rows = Array.from(
        event.currentTarget.closest("ul")?.querySelectorAll<HTMLElement>("[data-rule-row]") ?? [],
      );
      const index = rows.indexOf(event.currentTarget);
      rows[event.key === "ArrowDown" ? index + 1 : index - 1]?.focus();
    }
  }

  return (
    <ListItemButton
      ref={setNodeRef}
      selected={item.active}
      onClick={item.onClick}
      onKeyDown={handleRowKeyDown}
      data-rule-row
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
          slotProps={{
            input: { "aria-label": t("rulesPage.batch.selectRule", { name: item.name }) },
          }}
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
                  slotProps={{
                    input: {
                      "aria-label": t(
                        item.enabled
                          ? "rulesPage.listRow.disableRule"
                          : "rulesPage.listRow.enableRule",
                        { name: item.name },
                      ),
                    },
                  }}
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
              {item.chipLabel !== undefined && (
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
              )}
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
