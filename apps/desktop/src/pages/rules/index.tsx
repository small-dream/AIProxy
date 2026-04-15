import { Box, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useState } from "react";

import { BreakpointRulesPanel } from "@/features/rules/components/BreakpointRulesPanel";
import { MapRulesPanel } from "@/features/rules/components/MapRulesPanel";
import { RewriteRulesPanel } from "@/features/rules/components/RewriteRulesPanel";
import type { RulesTabValue } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";

export function RulesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<RulesTabValue>("rewrite");

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t("rulesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body2">
          {t("rulesPage.description")}
        </Typography>
      </Stack>

      <Tabs
        value={tab}
        onChange={(_, value: RulesTabValue) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 36, "& .MuiTab-root": { minHeight: 36, py: 0 } }}
      >
        <Tab value="breakpoint" label={t("rulesPage.tabs.breakpoint")} />
        <Tab value="rewrite" label={t("rulesPage.tabs.rewrite")} />
        <Tab value="mapLocal" label={t("rulesPage.tabs.mapLocal")} />
        <Tab value="mapRemote" label={t("rulesPage.tabs.mapRemote")} />
      </Tabs>

      <Box>
        {tab === "breakpoint" && <BreakpointRulesPanel />}
        {tab === "rewrite" && <RewriteRulesPanel />}
        {tab === "mapLocal" && <MapRulesPanel mode="local" />}
        {tab === "mapRemote" && <MapRulesPanel mode="remote" />}
      </Box>
    </Stack>
  );
}
