import { Box, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useState } from "react";

import { DnsMappingsPanel } from "@/features/rules/components/DnsMappingsPanel";
import { MapRulesPanel } from "@/features/rules/components/MapRulesPanel";
import { useI18n } from "@/i18n";

type MappingMode = "dns" | "local" | "remote";

export function MappingRulesPanel() {
  const { t } = useI18n();
  const [mode, setMode] = useState<MappingMode>("local");

  return (
    <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0 }}>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={mode}
        onChange={(_, value: MappingMode | null) => {
          if (value) setMode(value);
        }}
        sx={{
          alignSelf: "flex-start",
          bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.035),
          border: 1,
          borderColor: "divider",
          borderRadius: 1.25,
          p: 0.5,
          "& .MuiToggleButtonGroup-grouped": {
            border: 0,
            borderRadius: 1,
            color: "text.secondary",
            fontSize: 13,
            fontWeight: 500,
            height: 30,
            px: 1.25,
            textTransform: "none",
            "&.Mui-selected": {
              bgcolor: "background.paper",
              color: "text.primary",
              fontWeight: 650,
              boxShadow: (theme) => theme.palette.mode === "dark"
                ? "0 1px 0 rgba(255,255,255,0.04)"
                : "0 1px 2px rgba(15, 23, 42, 0.08)",
            },
          },
        }}
      >
        <ToggleButton value="local">{t("rulesPage.tabs.mapLocal")}</ToggleButton>
        <ToggleButton value="remote">{t("rulesPage.tabs.mapRemote")}</ToggleButton>
        <ToggleButton value="dns">{t("rulesPage.tabs.dns")}</ToggleButton>
      </ToggleButtonGroup>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {mode === "local" && <MapRulesPanel mode="local" />}
        {mode === "remote" && <MapRulesPanel mode="remote" />}
        {mode === "dns" && <DnsMappingsPanel />}
      </Box>
    </Stack>
  );
}
