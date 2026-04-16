import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import FileCopyRoundedIcon from "@mui/icons-material/FileCopyRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { downloadTextFile } from "@/lib/download";
import type {
  ExportFormat,
  ExportScope,
  SessionDetail,
  SessionSummary,
} from "@aiproxy/shared-types";
import { type ReactNode, useMemo, useState } from "react";

import { getSessionDetail } from "@/services/commands";
import { useI18n } from "@/i18n";
import {
  buildCurlBundle,
  buildHarArchive,
  buildSessionSnapshot,
} from "../session-export.helpers";

type Props = {
  allSessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  onClose: () => void;
  open: boolean;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export function SessionExportDialog({
  allSessions,
  filteredSessions,
  onClose,
  open,
  selectedSession,
  selectedSessionDetail,
}: Props) {
  const { t } = useI18n();
  const [scope, setScope] = useState<ExportScope>(selectedSession ? "selected" : "filtered");
  const [format, setFormat] = useState<ExportFormat>("json");
  const [isExporting, setIsExporting] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const scopeCount = useMemo(() => {
    if (scope === "selected") {
      return selectedSession ? 1 : 0;
    }

    if (scope === "filtered") {
      return filteredSessions.length;
    }

    return allSessions.length;
  }, [allSessions.length, filteredSessions.length, scope, selectedSession]);

  async function handleExport() {
    setErrorMessage(undefined);
    setFeedbackMessage(undefined);
    setIsExporting(true);

    try {
      const details = await loadDetailsForScope({
        allSessions,
        filteredSessions,
        scope,
        selectedSession,
        selectedSessionDetail,
      });

      if (format === "json") {
        downloadTextFile(
          `aiproxy-sessions-${Date.now()}.json`,
          JSON.stringify(buildSessionSnapshot(details), null, 2),
          "application/json",
        );
        setFeedbackMessage(t("sessionsExport.messages.exportedSnapshot"));
        return;
      }

      if (format === "har") {
        downloadTextFile(
          `aiproxy-sessions-${Date.now()}.har`,
          JSON.stringify(buildHarArchive(details), null, 2),
          "application/json",
        );
        setFeedbackMessage(t("sessionsExport.messages.exportedHar"));
        return;
      }

      const curlBundle = buildCurlBundle(details).join("\n\n");
      await navigator.clipboard?.writeText(curlBundle);
      setFeedbackMessage(t("sessionsExport.messages.copiedCurl"));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("common.errors.unexpected"));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <Dialog fullWidth maxWidth="md" open={open} onClose={onClose}>
      <DialogTitle>{t("sessionsExport.title")}</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("sessionsExport.scopeTitle")}</Typography>
            <Stack direction={{ xs: "column", md: "row" }} spacing={1.25}>
              <SelectableCard
                active={scope === "selected"}
                disabled={!selectedSession}
                title={t("sessionsExport.scopes.selected")}
                description={selectedSession ? selectedSession.url : t("sessionsExport.noSelectedSession")}
                onClick={() => setScope("selected")}
              />
              <SelectableCard
                active={scope === "filtered"}
                disabled={filteredSessions.length === 0}
                title={t("sessionsExport.scopes.filtered")}
                description={t("sessionsExport.filteredDescription", { count: filteredSessions.length })}
                onClick={() => setScope("filtered")}
              />
              <SelectableCard
                active={scope === "all"}
                disabled={allSessions.length === 0}
                title={t("sessionsExport.scopes.all")}
                description={t("sessionsExport.allDescription", { count: allSessions.length })}
                onClick={() => setScope("all")}
              />
            </Stack>
          </Stack>

          <Stack spacing={1}>
            <Typography variant="subtitle2">{t("sessionsExport.formatTitle")}</Typography>
            <Stack direction={{ xs: "column", md: "row" }} spacing={1.25}>
              <SelectableCard
                active={format === "json"}
                title={t("sessionsExport.formats.json")}
                description={t("sessionsExport.formatDescriptions.json")}
                icon={<DownloadRoundedIcon fontSize="small" />}
                onClick={() => setFormat("json")}
              />
              <SelectableCard
                active={format === "har"}
                title={t("sessionsExport.formats.har")}
                description={t("sessionsExport.formatDescriptions.har")}
                icon={<DownloadRoundedIcon fontSize="small" />}
                onClick={() => setFormat("har")}
              />
              <SelectableCard
                active={format === "curl"}
                title={t("sessionsExport.formats.curl")}
                description={t("sessionsExport.formatDescriptions.curl")}
                icon={<FileCopyRoundedIcon fontSize="small" />}
                onClick={() => setFormat("curl")}
              />
            </Stack>
          </Stack>

          <Alert severity="info" variant="outlined">
            {t("sessionsExport.summary", {
              count: scopeCount,
              format:
                format === "json"
                  ? t("sessionsExport.formats.json")
                  : format === "har"
                    ? t("sessionsExport.formats.har")
                    : t("sessionsExport.formats.curl"),
            })}
          </Alert>

          {feedbackMessage ? (
            <Alert severity="success" variant="outlined">
              {feedbackMessage}
            </Alert>
          ) : null}

          {errorMessage ? (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t("common.actions.cancel")}</Button>
        <Button
          variant="contained"
          onClick={handleExport}
          disabled={scopeCount === 0 || isExporting}
        >
          {format === "curl" ? t("sessionsExport.exportCurl") : t("sessionsExport.exportFile")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SelectableCard(props: {
  active: boolean;
  description: string;
  disabled?: boolean;
  icon?: ReactNode;
  onClick: () => void;
  title: string;
}) {
  const { active, description, disabled = false, icon, onClick, title } = props;

  return (
    <Paper
      elevation={0}
      onClick={disabled ? undefined : onClick}
      sx={{
        border: 1,
        borderColor: active ? "primary.main" : "divider",
        borderRadius: 2.5,
        cursor: disabled ? "not-allowed" : "pointer",
        flex: 1,
        opacity: disabled ? 0.55 : 1,
        p: 1.5,
      }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} alignItems="center">
          {icon ? <Box sx={{ display: "flex" }}>{icon}</Box> : null}
          <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
        </Stack>
        <Typography color="text.secondary" variant="body2">
          {description}
        </Typography>
      </Stack>
    </Paper>
  );
}

async function loadDetailsForScope(props: {
  allSessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  scope: ExportScope;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
}) {
  const { allSessions, filteredSessions, scope, selectedSession, selectedSessionDetail } = props;

  if (scope === "selected") {
    if (!selectedSession) {
      return [];
    }

    if (selectedSessionDetail && selectedSessionDetail.id === selectedSession.id) {
      return [selectedSessionDetail];
    }

    return [await getSessionDetail(selectedSession.id)];
  }

  const summaries = scope === "filtered" ? filteredSessions : allSessions;

  return Promise.all(summaries.map((session) => getSessionDetail(session.id)));
}
