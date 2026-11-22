import { useState } from "react";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import FileUploadRoundedIcon from "@mui/icons-material/FileUploadRounded";
import { Button, Stack, Tooltip } from "@mui/material";
import {
  coerceAppError,
  parseRulesExportFile,
  UNSUPPORTED_RULES_VERSION_CODE,
  type RulesExportFile,
} from "@aiproxy/shared-types";
import { DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";

import { useBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";
import { collectRulesForExport } from "@/features/rules/rules-import-export.helpers";
import {
  useDnsMappings,
  useMapRules,
  useRewriteRules,
  useScriptRules,
} from "@/features/rules/use-rule-center";
import { useThrottleProfiles, useThrottleRules } from "@/features/throttling/use-throttle-profiles";
import { pickAndReadRulesFile } from "@/services/commands/files";
import { useNotificationStore } from "@/services/notification.store";
import { downloadTextFile } from "@/lib/download";
import { isTauriRuntime } from "@/services/commands/runtime";
import { useI18n } from "@/i18n";

import { RulesImportPreviewDialog } from "./RulesImportPreviewDialog";

export function RulesImportExportButtons() {
  const { t } = useI18n();
  const { data: rewrite = [] } = useRewriteRules();
  const { data: map = [] } = useMapRules(undefined);
  const { data: dns = [] } = useDnsMappings(DEFAULT_WORKSPACE_ID);
  const { data: script = [] } = useScriptRules();
  const { data: breakpoint = [] } = useBreakpointRules();
  const { data: throttle = [] } = useThrottleRules();
  const { data: throttleProfiles = [] } = useThrottleProfiles();
  const [previewFile, setPreviewFile] = useState<RulesExportFile | null>(null);

  async function handleExport() {
    const file = collectRulesForExport({
      breakpoint,
      dns,
      map,
      rewrite,
      script,
      throttle,
      throttleProfiles,
    });
    const date = new Date().toISOString().slice(0, 10);
    try {
      await downloadTextFile(
        `aiproxy-rules-${date}.json`,
        JSON.stringify(file, null, 2),
        "application/json",
      );
      useNotificationStore.getState().push(t("rulesPage.importExport.exported"));
    } catch (error) {
      // M-11: a cancelled save dialog or a disk/permission failure used to
      // become an unhandled rejection with zero user feedback (the import
      // path already had this catch — this mirrors it).
      const message = coerceAppError(error).message;
      useNotificationStore.getState().push(message || t("common.errors.generic"));
    }
  }

  async function handleImport() {
    try {
      const picked = await pickAndReadRulesFile(t("rulesPage.importExport.previewTitle"));
      if (!picked) return;
      const file = parseRulesExportFile(JSON.parse(picked.contents));
      setPreviewFile(file);
    } catch (error) {
      // N-3: branch on the structured error code — the old check matched the
      // English substring "unsupported", which the parser's generic
      // UNKNOWN_ERROR could never contain, so the version-specific guidance
      // was unreachable dead code.
      const appError = coerceAppError(error);
      useNotificationStore
        .getState()
        .push(
          appError.code === UNSUPPORTED_RULES_VERSION_CODE
            ? t("rulesPage.importExport.unsupportedVersion")
            : t("rulesPage.importExport.invalidFile"),
        );
    }
  }

  const importDisabled = !isTauriRuntime();

  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", px: 1, py: 0.5 }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<FileDownloadRoundedIcon />}
        onClick={() => void handleExport()}
      >
        {t("rulesPage.importExport.export")}
      </Button>
      <Tooltip title={importDisabled ? t("rulesPage.importExport.importDisabledHint") : ""}>
        <span>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileUploadRoundedIcon />}
            disabled={importDisabled}
            onClick={() => void handleImport()}
          >
            {t("rulesPage.importExport.import")}
          </Button>
        </span>
      </Tooltip>
      <RulesImportPreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} />
    </Stack>
  );
}
