import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { downloadTextFile } from "@/lib/download";
import type { ExportScope, SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/i18n";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { SESSION_DETAIL_QUERY_KEY } from "@/features/sessions/use-session-detail";
import {
  buildHarArchive,
  loadSessionDetailsBatched,
  DEFAULT_EXPORT_CONTENT_OPTIONS,
} from "../session-export.helpers";

export type SessionExportDialogScope = ExportScope | "host";
export type SessionExportHostScope = {
  host: string;
  sessions: SessionSummary[];
};

type Props = {
  allSessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  hostScope?: SessionExportHostScope;
  initialScope?: SessionExportDialogScope;
  onClose: () => void;
  open: boolean;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export function SessionExportDialog({
  allSessions,
  filteredSessions,
  hostScope,
  initialScope,
  onClose,
  open,
  selectedSession,
  selectedSessionDetail,
}: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<SessionExportDialogScope>(
    initialScope ?? (selectedSession ? "selected" : "filtered"),
  );
  const [isExporting, setIsExporting] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  useEffect(() => {
    if (!open) {
      return;
    }

    setScope(
      initialScope ??
        (hostScope && hostScope.sessions.length > 0
          ? "host"
          : selectedSession
            ? "selected"
            : "filtered"),
    );
    setFeedbackMessage(undefined);
    setErrorMessage(undefined);
  }, [hostScope, initialScope, open, selectedSession]);

  const scopeCount = useMemo(() => {
    if (scope === "selected") {
      return selectedSession ? 1 : 0;
    }

    if (scope === "host") {
      return hostScope?.sessions.length ?? 0;
    }

    if (scope === "filtered") {
      return filteredSessions.length;
    }

    return allSessions.length;
  }, [
    allSessions.length,
    filteredSessions.length,
    hostScope?.sessions.length,
    scope,
    selectedSession,
  ]);

  async function handleExport() {
    setErrorMessage(undefined);
    setFeedbackMessage(undefined);
    setIsExporting(true);

    try {
      const details = await loadDetailsForScope({
        allSessions,
        filteredSessions,
        queryClient,
        scope,
        selectedSession,
        selectedSessionDetail,
        ...(hostScope ? { hostScope } : {}),
      });

      await downloadTextFile(
        `aiproxy-sessions-${Date.now()}.har`,
        JSON.stringify(buildHarArchive(details), null, 2),
        "application/json",
        { revealInFolder: true },
      );
      setFeedbackMessage(t("sessionsExport.messages.exportedHar"));
      onClose();
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
            <Box
              sx={{
                display: "grid",
                gap: 1.25,
                gridTemplateColumns: {
                  xs: "minmax(0, 1fr)",
                  md: "repeat(2, minmax(0, 1fr))",
                },
              }}
            >
              <SelectableCard
                active={scope === "selected"}
                disabled={!selectedSession}
                title={t("sessionsExport.scopes.selected")}
                description={
                  selectedSession ? (
                    <SessionScopePreview session={selectedSession} />
                  ) : (
                    t("sessionsExport.noSelectedSession")
                  )
                }
                onClick={() => setScope("selected")}
              />
              <SelectableCard
                active={scope === "host"}
                disabled={!hostScope || hostScope.sessions.length === 0}
                title={t("sessionsExport.scopes.host")}
                description={
                  hostScope
                    ? t("sessionsExport.hostDescription", {
                        count: hostScope.sessions.length,
                        host: hostScope.host,
                      })
                    : t("sessionsExport.noHostScope")
                }
                icon={<PublicRoundedIcon fontSize="small" />}
                onClick={() => setScope("host")}
              />
              <SelectableCard
                active={scope === "filtered"}
                disabled={filteredSessions.length === 0}
                title={t("sessionsExport.scopes.filtered")}
                description={t("sessionsExport.filteredDescription", {
                  count: filteredSessions.length,
                })}
                onClick={() => setScope("filtered")}
              />
              <SelectableCard
                active={scope === "all"}
                disabled={allSessions.length === 0}
                title={t("sessionsExport.scopes.all")}
                description={t("sessionsExport.allDescription", { count: allSessions.length })}
                onClick={() => setScope("all")}
              />
            </Box>
          </Stack>

          <Alert severity="info" variant="outlined">
            {t("sessionsExport.summary", {
              count: scopeCount,
              format: t("sessionsExport.formats.har"),
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
          {t("sessionsExport.exportHar")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function SelectableCard(props: {
  active: boolean;
  description: ReactNode;
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
        backgroundColor: active ? "action.selected" : "background.paper",
        border: 1,
        borderColor: active ? "primary.main" : "divider",
        borderRadius: 2.5,
        cursor: disabled ? "not-allowed" : "pointer",
        height: "100%",
        minWidth: 0,
        opacity: disabled ? 0.55 : 1,
        p: 1.5,
        transition: "border-color 140ms ease, background-color 140ms ease, transform 140ms ease",
        "&:hover": disabled
          ? undefined
          : {
              borderColor: "primary.main",
              transform: "translateY(-1px)",
            },
      }}
    >
      <Stack spacing={0.75} sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{
          alignItems: "center"
        }}>
          {icon ? <Box sx={{ display: "flex" }}>{icon}</Box> : null}
          <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
        </Stack>
        <Box
          sx={{
            color: "text.secondary",
            minWidth: 0,
            overflowWrap: "anywhere",
            typography: "body2",
          }}
        >
          {description}
        </Box>
      </Stack>
    </Paper>
  );
}

function SessionScopePreview({ session }: { session: SessionSummary }) {
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          minWidth: 0
        }}>
        <Chip label={session.method} size="small" sx={{ fontWeight: 700 }} />
        <Typography sx={{ fontWeight: 600, minWidth: 0 }} variant="body2">
          {session.host}
        </Typography>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.primary",
          fontFamily: "ui-monospace, monospace",
          minWidth: 0,
          overflowWrap: "anywhere"
        }}>
        {session.path}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          minWidth: 0,
          overflowWrap: "anywhere"
        }}>
        {session.url}
      </Typography>
    </Stack>
  );
}

async function loadDetailsForScope(props: {
  allSessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  hostScope?: SessionExportHostScope;
  queryClient: QueryClient;
  scope: SessionExportDialogScope;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
}) {
  const {
    allSessions,
    filteredSessions,
    hostScope,
    queryClient,
    scope,
    selectedSession,
    selectedSessionDetail,
  } = props;

  if (scope === "selected") {
    if (!selectedSession) {
      return [];
    }

    if (selectedSessionDetail && selectedSessionDetail.id === selectedSession.id) {
      queryClient.setQueryData(
        [SESSION_DETAIL_QUERY_KEY, selectedSession.id],
        selectedSessionDetail,
      );
    }

    return [
      await ensureSessionDetailContent(queryClient, selectedSession.id, {
        ...DEFAULT_EXPORT_CONTENT_OPTIONS,
      }),
    ];
  }

  const summaries =
    scope === "host"
      ? (hostScope?.sessions ?? [])
      : scope === "filtered"
        ? filteredSessions
        : allSessions;

  return loadSessionDetailsBatched(queryClient, summaries);
}
