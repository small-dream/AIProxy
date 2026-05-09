import { Box, Chip, Stack, Tab, Tabs, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useState } from "react";

import { BreakpointRulesPanel } from "@/features/rules/components/BreakpointRulesPanel";
import { DnsMappingsPanel } from "@/features/rules/components/DnsMappingsPanel";
import { MapRulesPanel } from "@/features/rules/components/MapRulesPanel";
import { RewriteRulesPanel } from "@/features/rules/components/RewriteRulesPanel";
import { ScriptRulesPanel } from "@/features/rules/components/ScriptRulesPanel";
import type { RulesTabValue } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";

export function RulesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<RulesTabValue>("rewrite");
  const tabDescriptionByValue: Record<RulesTabValue, string> = {
    breakpoint: t("rulesPage.breakpointRulesDescription"),
    dns: t("rulesPage.dns.emptyDescription"),
    mapLocal: t("rulesPage.mapLocal.description"),
    mapRemote: t("rulesPage.mapRemote.description"),
    rewrite: t("rulesPage.rewrite.description"),
    script: t("rulesPage.script.emptyDescription"),
  };

  return (
    <Stack spacing={2.25} sx={{ minHeight: "100%" }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        spacing={1.5}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          pb: 1.75,
        }}
      >
        <Stack spacing={0.5} sx={{ maxWidth: 760 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h4" sx={{ fontSize: 28, fontWeight: 600, lineHeight: 1.15 }}>
              {t("rulesPage.title")}
            </Typography>
            <Chip
              size="small"
              label={t("rulesPage.centerTitle")}
              sx={{
                bgcolor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.1),
                color: "primary.main",
                fontSize: 11,
                height: 22,
              }}
            />
          </Stack>
          <Typography color="text.secondary" variant="body2">
            {tabDescriptionByValue[tab] || t("rulesPage.description")}
          </Typography>
        </Stack>
      </Stack>

      <Tabs
        value={tab}
        onChange={(_, value: RulesTabValue) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{
          bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.035),
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          minHeight: 38,
          p: 0.5,
          width: "fit-content",
          maxWidth: "100%",
          "& .MuiTabs-indicator": { display: "none" },
          "& .MuiTab-root": {
            borderRadius: "7px",
            color: "text.secondary",
            minHeight: 30,
            px: 1.75,
            py: 0,
          },
          "& .Mui-selected": {
            bgcolor: "background.paper",
            boxShadow: (theme) => theme.palette.mode === "dark" ? "0 1px 0 rgba(255,255,255,0.04)" : "0 1px 2px rgba(15, 23, 42, 0.08)",
            color: "text.primary",
          },
        }}
      >
        <Tab value="breakpoint" label={t("rulesPage.tabs.breakpoint")} />
        <Tab value="rewrite" label={t("rulesPage.tabs.rewrite")} />
        <Tab value="mapLocal" label={t("rulesPage.tabs.mapLocal")} />
        <Tab value="mapRemote" label={t("rulesPage.tabs.mapRemote")} />
        <Tab value="dns" label={t("rulesPage.tabs.dns")} />
        <Tab value="script" label={t("rulesPage.tabs.script")} />
      </Tabs>

      <Box>
        {tab === "breakpoint" && <BreakpointRulesPanel />}
        {tab === "rewrite" && <RewriteRulesPanel />}
        {tab === "mapLocal" && <MapRulesPanel mode="local" />}
        {tab === "mapRemote" && <MapRulesPanel mode="remote" />}
        {tab === "dns" && <DnsMappingsPanel />}
        {tab === "script" && <ScriptRulesPanel />}
      </Box>
    </Stack>
  );
}
