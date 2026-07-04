import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, Button, IconButton, OutlinedInput, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { HeaderEntry } from "@aiproxy/shared-types";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const EDITOR_GRID_TEMPLATE = "minmax(160px, 0.78fr) minmax(0, 1.72fr) 36px";

// Each editable row carries a LOCAL-only id used purely as the React key.
// Rows previously used `key={index}`, so deleting a middle row re-indexed the
// list and React reused DOM nodes by position — the wrong row's input state
// then bound to the shifted entries (focus jumps, values visually shuffle).
//
// The id never leaves this component: onChange still emits a plain
// HeaderEntry[] (name/value only), so the shared HeaderEntry contract and any
// downstream Tauri commands / stores are unchanged.
type EditableRow = HeaderEntry & { id: string };

function sameEntries(a: HeaderEntry[], b: HeaderEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return other !== undefined && entry.name === other.name && entry.value === other.value;
  });
}

function toHeaderEntries(rows: EditableRow[]): HeaderEntry[] {
  return rows.map((row) => ({ name: row.name, value: row.value }));
}

export function EditableKeyValueTable({
  items,
  onChange,
  namePlaceholder = "Name",
  valuePlaceholder = "Value",
}: {
  items: HeaderEntry[];
  onChange: (items: HeaderEntry[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useI18n();

  // Local rows mirror `items` but carry a stable per-row id. The id survives
  // this component's own edits (add/update/remove) because we mutate `rows`
  // directly; it is only regenerated when the parent pushes an externally
  // different `items` (e.g. loading a saved session).
  const [rows, setRows] = useState<EditableRow[]>(() =>
    items.map((item) => ({ ...item, id: crypto.randomUUID() })),
  );
  const lastEmittedRef = useRef<HeaderEntry[]>(items);

  // Re-sync ids when the parent provides a value we did not just emit (an
  // external reset), so we never bind a stale id to foreign data.
  useEffect(() => {
    if (sameEntries(lastEmittedRef.current, items)) return;
    lastEmittedRef.current = items;
    setRows(items.map((item) => ({ ...item, id: crypto.randomUUID() })));
  }, [items]);

  function emit(next: EditableRow[]) {
    // Strip the local id at the boundary so callers receive HeaderEntry[].
    const stripped = toHeaderEntries(next);
    lastEmittedRef.current = stripped;
    setRows(next);
    onChange(stripped);
  }

  function handleUpdate(index: number, field: "name" | "value", newValue: string) {
    const updated = [...rows];
    const current = updated[index];
    if (!current) return;
    updated[index] =
      field === "name"
        ? { ...current, name: newValue }
        : { ...current, value: newValue };
    emit(updated);
  }

  function handleRemove(index: number) {
    emit(rows.filter((_, i) => i !== index));
  }

  function handleAdd() {
    emit([...rows, { id: crypto.randomUUID(), name: "", value: "" }]);
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      {/* H15/M26: judge the empty state from `rows` (the rendered source), not
          `items`. The sync effect that rebuilds `rows` from `items` runs AFTER
          render, so for one frame `items` and `rows` can disagree — checking
          `items` could show the empty hint and the rows at once (or neither). */}
      {rows.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            px: 1,
            py: 1.25
          }}>
          {t("common.empty.noData")}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          <Box
            sx={(theme) => ({
              bgcolor: alpha(
                theme.palette.text.primary,
                theme.palette.mode === "dark" ? 0.05 : 0.035,
              ),
              borderRadius: 1,
              display: "grid",
              gridTemplateColumns: EDITOR_GRID_TEMPLATE,
              minHeight: 22,
            })}
          >
            {[namePlaceholder, valuePlaceholder, ""].map((label, index) => (
              <Typography
                key={`${label}:${index}`}
                variant="caption"
                sx={{
                  color: "text.secondary",
                  alignItems: "center",
                  display: "flex",
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: 0,
                  minWidth: 0,
                  px: 1
                }}>
                {label}
              </Typography>
            ))}
          </Box>
          {rows.map((row, index) => (
            <Box
              key={row.id}
              sx={{
                alignItems: "center",
                display: "grid",
                gap: 0.5,
                gridTemplateColumns: EDITOR_GRID_TEMPLATE,
                minHeight: 34,
              }}
            >
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "name", event.target.value)}
                placeholder={namePlaceholder}
                size="small"
                sx={{
                  fontFamily: appFontCssVars.content,
                  fontSize: 12.75,
                  minWidth: 0,
                  "& .MuiOutlinedInput-input": {
                    py: 0.75,
                  },
                }}
                value={row.name}
              />
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "value", event.target.value)}
                placeholder={valuePlaceholder}
                size="small"
                sx={{
                  fontFamily: appFontCssVars.content,
                  fontSize: 12.75,
                  minWidth: 0,
                  "& .MuiOutlinedInput-input": {
                    py: 0.75,
                  },
                }}
                value={row.value}
              />
              <Tooltip title={t("common.actions.remove")}>
                <IconButton
                  onClick={() => handleRemove(index)}
                  size="small"
                  sx={{ color: "text.secondary", flex: "0 0 auto", p: 0.65 }}
                >
                  <DeleteOutlineRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Stack>
      )}
      <Box sx={{ mt: 1 }}>
        <Button
          startIcon={<AddRoundedIcon sx={{ fontSize: 18 }} />}
          onClick={handleAdd}
          size="small"
          sx={{ minHeight: 28, px: 1.125 }}
          variant="text"
        >
          {t("common.actions.add")}
        </Button>
      </Box>
    </Box>
  );
}
