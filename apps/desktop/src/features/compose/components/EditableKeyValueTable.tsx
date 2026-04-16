import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, IconButton, OutlinedInput, Stack, Tooltip, Typography } from "@mui/material";
import type { HeaderEntry } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

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
    <Box>
      {items.length === 0 ? (
        <Typography color="text.secondary" sx={{ py: 1 }} variant="body2">
          {t("common.empty.noData")}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {items.map((item, index) => (
            <Stack direction="row" key={index} spacing={0.5} sx={{ alignItems: "center" }}>
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "name", event.target.value)}
                placeholder={namePlaceholder}
                size="small"
                sx={{ flex: 1, fontFamily: fontFamilies.mono, fontSize: 13 }}
                value={item.name}
              />
              <OutlinedInput
                onChange={(event) => handleUpdate(index, "value", event.target.value)}
                placeholder={valuePlaceholder}
                size="small"
                sx={{ flex: 1.8, fontFamily: fontFamilies.mono, fontSize: 13 }}
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
            </Stack>
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 0.5 }}>
        <IconButton
          color="primary"
          onClick={handleAdd}
          size="small"
          sx={{ borderRadius: 1, px: 1 }}
        >
          <AddRoundedIcon sx={{ fontSize: 18 }} />
          <Typography sx={{ fontSize: 12, ml: 0.25 }} variant="caption">
            {t("common.actions.add")}
          </Typography>
        </IconButton>
      </Box>
    </Box>
  );
}
