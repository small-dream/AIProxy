import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";
import type { RulesExportFile } from "@aiproxy/shared-types";

import { useBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";
import { useThrottleProfiles } from "@/features/throttling/use-throttle-profiles";
import {
  planRulesImport,
  regenerateImportedBreakpointRules,
  regenerateImportedProfiles,
  regenerateImportedRules,
  type RulesImportCounts,
} from "@/features/rules/rules-import-export.helpers";
import {
  saveDnsMapping,
  saveMapRule,
  saveRewriteRule,
  saveScriptRule,
  setBreakpointRules,
} from "@/services/commands";
import { saveThrottleProfile, saveThrottleRule } from "@/services/commands/throttling";
import { useNotificationStore } from "@/services/notification.store";
import { useI18n, type TranslationKey } from "@/i18n";

type ImportKind = keyof RulesImportCounts;

const KIND_LABELS: Array<{ key: TranslationKey; kind: ImportKind }> = [
  { key: "rulesPage.tabs.rewrite", kind: "rewrite" },
  { key: "rulesPage.tabs.mapping", kind: "map" },
  { key: "rulesPage.tabs.script", kind: "script" },
  { key: "rulesPage.tabs.breakpoint", kind: "breakpoint" },
  { key: "rulesPage.importExport.throttleRules", kind: "throttle" },
  { key: "rulesPage.importExport.throttleProfiles", kind: "throttleProfiles" },
];

export function RulesImportPreviewDialog(props: {
  file: RulesExportFile | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { file, onClose } = props;
  const plan = useMemo(() => (file ? planRulesImport(file) : null), [file]);
  const [selected, setSelected] = useState<Set<ImportKind>>(new Set());

  const { data: existingBreakpoints = [] } = useBreakpointRules();
  const { data: existingProfiles = [] } = useThrottleProfiles();

  useEffect(() => {
    if (!plan) return;
    setSelected(
      new Set((Object.keys(plan.counts) as ImportKind[]).filter((kind) => plan.counts[kind] > 0)),
    );
  }, [plan]);

  const selectedTotal = useMemo(() => {
    if (!plan) return 0;
    return (Object.keys(plan.counts) as ImportKind[]).reduce(
      (sum, kind) => (selected.has(kind) ? sum + plan.counts[kind] : sum),
      0,
    );
  }, [plan, selected]);

  if (!file || !plan) {
    return null;
  }

  function toggle(kind: ImportKind) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }

  async function applyImport() {
    if (!file || selectedTotal === 0) {
      useNotificationStore.getState().push(t("rulesPage.importExport.nothingSelected"));
      return;
    }

    const saved: PromiseSettledResult<unknown>[] = [];
    const settle = async (promise: Promise<unknown>) => {
      try {
        await promise;
        saved.push({ status: "fulfilled", value: undefined });
      } catch (reason) {
        saved.push({ status: "rejected", reason });
      }
    };

    if (selected.has("rewrite")) {
      for (const rule of regenerateImportedRules(file.rules.rewrite)) {
        await settle(saveRewriteRule(rule));
      }
    }
    if (selected.has("map")) {
      for (const rule of regenerateImportedRules(file.rules.map)) {
        await settle(saveMapRule(rule));
      }
    }
    if (selected.has("dns")) {
      for (const rule of regenerateImportedRules(file.rules.dns)) {
        await settle(saveDnsMapping(rule));
      }
    }
    if (selected.has("script")) {
      for (const rule of regenerateImportedRules(file.rules.script)) {
        await settle(saveScriptRule(rule));
      }
    }
    if (selected.has("throttleProfiles")) {
      for (const profile of regenerateImportedProfiles(
        file.rules.throttleProfiles,
        existingProfiles,
      )) {
        await settle(saveThrottleProfile(profile));
      }
    }
    if (selected.has("throttle")) {
      for (const rule of regenerateImportedRules(file.rules.throttle)) {
        await settle(saveThrottleRule(rule));
      }
    }
    if (selected.has("breakpoint")) {
      const next = [
        ...existingBreakpoints,
        ...regenerateImportedBreakpointRules(file.rules.breakpoint),
      ];
      await settle(setBreakpointRules(next));
    }

    const failed = saved.filter((result) => result.status === "rejected").length;
    useNotificationStore
      .getState()
      .push(
        failed > 0
          ? t("rulesPage.importExport.imported", { count: selectedTotal - failed })
          : t("rulesPage.importExport.imported", { count: selectedTotal }),
      );
    onClose();
  }

  return (
    <Dialog fullWidth maxWidth="sm" open onClose={onClose}>
      <DialogTitle>{t("rulesPage.importExport.previewTitle")}</DialogTitle>
      <DialogContent>
        <Stack spacing={1} sx={{ pb: 1 }}>
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 13 }}>
            {t("rulesPage.importExport.previewHint")}
          </Typography>
          <Stack spacing={0.25}>
            {KIND_LABELS.filter(({ kind }) => plan.counts[kind] > 0).map(({ key, kind }) => (
              <FormControlLabel
                key={kind}
                control={
                  <Checkbox
                    size="small"
                    checked={selected.has(kind)}
                    onChange={() => toggle(kind)}
                  />
                }
                label={t("rulesPage.importExport.countLabel", {
                  count: plan.counts[kind],
                  kind: t(key),
                })}
              />
            ))}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
        <Button
          variant="contained"
          disabled={selectedTotal === 0}
          onClick={() => void applyImport()}
        >
          {t("rulesPage.importExport.importButton", { count: selectedTotal })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
