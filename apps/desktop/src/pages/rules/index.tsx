import { Box, Paper, Stack, Tab, Tabs } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { BreakpointRulesPanel } from "@/features/rules/components/BreakpointRulesPanel";
import {
  MappingRulesPanel,
  type MappingRulesPanelHandle,
} from "@/features/rules/components/MappingRulesPanel";
import {
  RewriteRulesPanel,
  type RewriteRulesPanelHandle,
} from "@/features/rules/components/RewriteRulesPanel";
import { ScriptRulesPanel } from "@/features/rules/components/ScriptRulesPanel";
import { RulesImportExportButtons } from "@/features/rules/components/RulesImportExportButtons";
import type { RulesPanelHandle, RulesTabValue } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";

export function RulesPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [tab, setTab] = useState<RulesTabValue>("rewrite");
  const breakpointPanelRef = useRef<RulesPanelHandle>(null);
  const rewritePanelRef = useRef<RewriteRulesPanelHandle>(null);
  const mappingPanelRef = useRef<MappingRulesPanelHandle>(null);
  const scriptPanelRef = useRef<RulesPanelHandle>(null);
  // Consume-once marker for the mapLocalSeed deep link, keyed by the history
  // entry, so a vetoed switch is not re-prompted on every later re-render.
  const lastHandledSeedKeyRef = useRef<string | null>(null);
  const seedHandlingRef = useRef(false);

  function panelForTab(value: RulesTabValue): RulesPanelHandle | null | undefined {
    switch (value) {
      case "breakpoint":
        return breakpointPanelRef.current;
      case "rewrite":
        return rewritePanelRef.current;
      case "mapping":
        return mappingPanelRef.current;
      case "script":
        return scriptPanelRef.current;
    }
  }

  // P0-2: switching tabs unmounts the active panel and silently dropped its
  // draft, so every panel now vetoes through the shared unsaved-changes guard.
  async function handleTabChange(value: RulesTabValue): Promise<boolean> {
    if (value === tab) return true;
    const allowed = (await panelForTab(tab)?.confirmLeave()) ?? true;
    if (!allowed) return false;
    setTab(value);
    return true;
  }

  // The sessions page routes here with a mapLocalSeed for the "Map Local this
  // request" flow; land on the mapping tab so the pre-filled draft is visible.
  // Routed through handleTabChange so a dirty editor on the CURRENT tab can
  // still veto the switch. When the mapping tab is already active this call is
  // a no-op — the mapping panel then guards the seed consumption itself, since
  // applying the seed replaces its in-flight draft. Either way nothing is
  // silently lost: the seed stays in history state until the mapping panel
  // actually consumes it.
  // Deliberately no dep array: handleTabChange closes over `tab` and gets a
  // fresh identity every render, so listing deps would be equivalent anyway.
  // The history-entry key makes the handling run-once per navigation.
  useEffect(() => {
    const state = location.state as { mapLocalSeed?: unknown } | null;
    if (!state?.mapLocalSeed) return;
    if (lastHandledSeedKeyRef.current === location.key) return;
    // When mapping is already mounted, the child owns seed consumption and its
    // own dirty guard. Do not mark the history entry here before that child has
    // confirmed and consumed it.
    if (tab === "mapping") return;
    if (seedHandlingRef.current) return;
    seedHandlingRef.current = true;
    void handleTabChange("mapping").then((handled) => {
      seedHandlingRef.current = false;
      if (handled) lastHandledSeedKeyRef.current = location.key;
    });
  });

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
        <Stack
          direction="row"
          sx={{
            bgcolor: (theme) =>
              theme.palette.mode === "dark"
                ? alpha(theme.palette.background.default, 0.28)
                : alpha(theme.palette.background.default, 0.62),
            borderBottom: 1,
            borderColor: "divider",
            alignItems: "flex-start",
            minWidth: 0,
          }}
        >
          <Tabs
            value={tab}
            onChange={(_, value: RulesTabValue) => void handleTabChange(value)}
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
          <Box sx={{ flex: 1 }} />
          <RulesImportExportButtons />
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {tab === "breakpoint" && <BreakpointRulesPanel ref={breakpointPanelRef} />}
          {tab === "rewrite" && <RewriteRulesPanel ref={rewritePanelRef} />}
          {tab === "mapping" && <MappingRulesPanel ref={mappingPanelRef} />}
          {tab === "script" && <ScriptRulesPanel ref={scriptPanelRef} />}
        </Box>
      </Paper>
    </Stack>
  );
}
