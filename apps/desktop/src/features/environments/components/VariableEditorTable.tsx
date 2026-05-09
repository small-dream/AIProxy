import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, Button, IconButton, OutlinedInput, Stack, Switch, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const EDITOR_GRID_TEMPLATE = "48px minmax(180px, 0.85fr) minmax(0, 1.7fr) 40px";

export interface VariableRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  sortOrder: number;
}

export function VariableEditorTable({
  variables,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
}: {
  variables: VariableRow[];
  onChange: (variables: VariableRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useI18n();

  function handleToggle(index: number) {
    const updated = [...variables];
    const current = updated[index];
    if (!current) return;
    updated[index] = { ...current, enabled: !current.enabled };
    onChange(updated);
  }

  function handleUpdate(index: number, field: "key" | "value", newValue: string) {
    const updated = [...variables];
    const current = updated[index];
    if (!current) return;
    updated[index] = { ...current, [field]: newValue };
    onChange(updated);
  }

  function handleRemove(index: number) {
    onChange(variables.filter((_, i) => i !== index));
  }

  function handleAdd() {
    onChange([
      ...variables,
      { id: crypto.randomUUID(), key: "", value: "", enabled: true, sortOrder: variables.length },
    ]);
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      {variables.length === 0 ? (
        <Typography color="text.secondary" sx={{ px: 1, py: 1.25 }} variant="body2">
          {t("common.empty.noData")}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          <Box
            sx={(theme) => ({
              bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.035),
              borderRadius: 1,
              display: "grid",
              gridTemplateColumns: EDITOR_GRID_TEMPLATE,
              minHeight: 24,
            })}
          >
            {["", keyPlaceholder, valuePlaceholder, ""].map((label, index) => (
              <Typography
                color="text.secondary"
                key={`${label}:${index}`}
                sx={{
                  alignItems: "center",
                  display: "flex",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0,
                  minWidth: 0,
                  px: 1,
                }}
                variant="caption"
              >
                {label}
              </Typography>
            ))}
          </Box>
          {variables.map((item, index) => (
            <Box
              key={item.id}
              sx={{
                alignItems: "center",
                display: "grid",
                gap: 0.5,
                gridTemplateColumns: EDITOR_GRID_TEMPLATE,
                minHeight: 38,
                opacity: item.enabled ? 1 : 0.5,
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Switch
                  checked={item.enabled}
                  onChange={() => handleToggle(index)}
                  size="small"
                />
              </Box>
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "key", event.target.value)}
                placeholder={keyPlaceholder}
                size="small"
                sx={{
                  fontFamily: appFontCssVars.content,
                  fontSize: 13,
                  minWidth: 0,
                  "& .MuiOutlinedInput-input": { py: 1 },
                }}
                value={item.key}
              />
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "value", event.target.value)}
                placeholder={valuePlaceholder}
                size="small"
                sx={{
                  fontFamily: appFontCssVars.content,
                  fontSize: 13,
                  minWidth: 0,
                  "& .MuiOutlinedInput-input": { py: 1 },
                }}
                value={item.value}
              />
              <Tooltip title={t("common.actions.remove")}>
                <IconButton
                  onClick={() => handleRemove(index)}
                  size="small"
                  sx={{ color: "text.secondary", flex: "0 0 auto" }}
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
          sx={{ minHeight: 30, px: 1.25 }}
          variant="text"
        >
          {t("collectionsPage.addVariable")}
        </Button>
      </Box>
    </Box>
  );
}
