import { Box, Paper, Stack, Tab, Tabs } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useState } from "react";

import { BreakpointRulesPanel } from "@/features/rules/components/BreakpointRulesPanel";
import { MappingRulesPanel } from "@/features/rules/components/MappingRulesPanel";
import { RewriteRulesPanel } from "@/features/rules/components/RewriteRulesPanel";
import { ScriptRulesPanel } from "@/features/rules/components/ScriptRulesPanel";
import type { RulesTabValue } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";

export function RulesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<RulesTabValue>("rewrite");

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <Paper
        elevation={0}
        sx={(theme) => ({
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.94 : 0.98,
          ),
          border: "1px solid",
          borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
          borderRadius: 1.25,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 16px 44px rgba(0, 0, 0, 0.28)"
              : "0 16px 40px rgba(15, 23, 42, 0.08)",
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        })}
        variant="outlined"
      >
        <Box
          sx={{
            bgcolor: (theme) =>
              theme.palette.mode === "dark"
                ? alpha(theme.palette.background.default, 0.28)
                : alpha(theme.palette.background.default, 0.62),
            borderBottom: 1,
            borderColor: "divider",
            minWidth: 0,
          }}
        >
          <Tabs
            value={tab}
            onChange={(_, value: RulesTabValue) => setTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{
              minHeight: 42,
              px: 0.75,
              py: 0.5,
              "& .MuiTabs-flexContainer": {
                gap: 0.5,
              },
              "& .MuiTabs-indicator": {
                display: "none",
              },
              "& .MuiTab-root": {
                border: "1px solid transparent",
                borderRadius: 1.25,
                color: "text.secondary",
                fontSize: 13,
                fontWeight: 500,
                height: 30,
                minHeight: 30,
                minWidth: 0,
                px: 1.1,
                py: 0,
                textTransform: "none",
                transition:
                  "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
                "&:hover": {
                  bgcolor: (theme) =>
                    alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  color: "text.primary",
                },
              },
              "& .Mui-selected": {
                bgcolor: (theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.1),
                borderColor: (theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.38 : 0.22),
                color: "text.primary",
                fontWeight: 600,
              },
            }}
          >
            <Tab value="breakpoint" label={t("rulesPage.tabs.breakpoint")} />
            <Tab value="rewrite" label={t("rulesPage.tabs.rewrite")} />
            <Tab value="mapping" label={t("rulesPage.tabs.mapping")} />
            <Tab value="script" label={t("rulesPage.tabs.script")} />
          </Tabs>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {tab === "breakpoint" && <BreakpointRulesPanel />}
          {tab === "rewrite" && <RewriteRulesPanel />}
          {tab === "mapping" && <MappingRulesPanel />}
          {tab === "script" && <ScriptRulesPanel />}
        </Box>
      </Paper>
    </Stack>
  );
}
