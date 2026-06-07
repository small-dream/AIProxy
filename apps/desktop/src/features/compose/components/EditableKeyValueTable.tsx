import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, Button, IconButton, OutlinedInput, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { HeaderEntry } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const EDITOR_GRID_TEMPLATE = "minmax(160px, 0.78fr) minmax(0, 1.72fr) 36px";

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

  function handleUpdate(index: number, field: "name" | "value", newValue: string) {
    const updated = [...items];
    const current = updated[index];
    if (!current) return;
    if (field === "name") {
      updated[index] = { name: newValue, value: current.value };
    } else {
      updated[index] = { name: current.name, value: newValue };
    }
    onChange(updated);
  }

  function handleRemove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function handleAdd() {
    onChange([...items, { name: "", value: "" }]);
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      {items.length === 0 ? (
        <Typography color="text.secondary" sx={{ px: 1, py: 1.25 }} variant="body2">
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
                color="text.secondary"
                key={`${label}:${index}`}
                sx={{
                  alignItems: "center",
                  display: "flex",
                  fontSize: 11.5,
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
          {items.map((item, index) => (
            <Box
              key={index}
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
                value={item.name}
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
                value={item.value}
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
