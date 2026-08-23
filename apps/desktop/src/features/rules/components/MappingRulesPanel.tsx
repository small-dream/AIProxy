import { Box, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import { DnsMappingsPanel } from "@/features/rules/components/DnsMappingsPanel";
import { MapRulesPanel } from "@/features/rules/components/MapRulesPanel";
import type { RulesPanelHandle } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";

type MappingMode = "dns" | "local" | "remote";

export type MappingRulesPanelHandle = RulesPanelHandle;

/**
 * The mapping tab hosts three sub-editors behind a mode toggle. Each child
 * carries its own unsaved-changes guard; this wrapper forwards the ACTIVE
 * child's handle to the Rules page, and runs the same veto when switching the
 * internal mode (which unmounts the previous child just like a tab switch).
 */
export const MappingRulesPanel = forwardRef<MappingRulesPanelHandle>(
  function MappingRulesPanel(_props, ref) {
    const { t } = useI18n();
    const [mode, setMode] = useState<MappingMode>("local");
    const localRef = useRef<RulesPanelHandle>(null);
    const remoteRef = useRef<RulesPanelHandle>(null);
    const dnsRef = useRef<RulesPanelHandle>(null);

    function activeHandle(): RulesPanelHandle | null {
      if (mode === "local") return localRef.current;
      if (mode === "remote") return remoteRef.current;
      return dnsRef.current;
    }

    useImperativeHandle<MappingRulesPanelHandle, RulesPanelHandle>(
      ref,
      () => ({
        // Read live through the refs so the flag stays correct after an internal
        // mode switch without re-creating the handle object.
        get isDirty() {
          return activeHandle()?.isDirty ?? false;
        },
        confirmLeave: async () => (await activeHandle()?.confirmLeave()) ?? true,
      }),
      // `mode` is read through closure state; re-create the handle when it
      // changes so `activeHandle` resolves to the newly mounted child.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mode],
    );

    async function handleModeChange(value: MappingMode | null) {
      if (!value || value === mode) return;
      // Switching modes unmounts the active sub-editor, so its draft needs the
      // same confirmation a tab switch gets.
      const allowed = (await activeHandle()?.confirmLeave()) ?? true;
      if (!allowed) return;
      setMode(value);
    }

    return (
      <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_, value: MappingMode | null) => void handleModeChange(value)}
          sx={{
            alignSelf: "flex-start",
            bgcolor: (theme) =>
              alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.035),
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
                boxShadow: (theme) =>
                  theme.palette.mode === "dark"
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
          {mode === "local" && <MapRulesPanel ref={localRef} mode="local" />}
          {mode === "remote" && <MapRulesPanel ref={remoteRef} mode="remote" />}
          {mode === "dns" && <DnsMappingsPanel ref={dnsRef} />}
        </Box>
      </Stack>
    );
  },
);
