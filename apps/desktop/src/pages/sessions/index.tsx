import {
  coerceAppError,
  isAppError,
} from "@pharles/shared-types";
import { Alert, Box, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { Button, Typography } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useClearSessions, useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { SessionExportDialog } from "@/features/sessions/components/SessionExportDialog";
import { SessionExplorerPane } from "@/features/sessions/components/SessionExplorerPane";
import { SessionInspectorWorkspace } from "@/features/sessions/components/SessionInspectorWorkspace";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import { buildSessionHostGroups, reconcileExpandedKeys } from "@/features/sessions/session-explorer.helpers";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";

const EXPLORER_WIDTH_STORAGE_KEY = "pharles.sessions.explorerWidth";
const REQUEST_COLLAPSED_STORAGE_KEY = "pharles.sessions.requestCollapsed";

export function SessionsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const loadFromSession = useComposeEditorStore((s) => s.loadFromSession);
  const { data: proxyStatus, error, isLoading } = useProxyStatus();
  const {
    data: sessions = [],
    error: sessionsError,
    isLoading: areSessionsLoading,
  } = useSessions(proxyStatus?.running ?? false);
  const clearSessionsMutation = useClearSessions();
  const dragFrameRef = useRef<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [searchValue, setSearchValue] = useState("");
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);
  const [requestInspectorTab, setRequestInspectorTab] = useState<RequestInspectorTab>("overview");
  const [responseInspectorTab, setResponseInspectorTab] = useState<ResponseInspectorTab>("overview");
  const [requestCollapsed, setRequestCollapsed] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(360);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const hostGroups = useMemo(() => buildSessionHostGroups(sessions, searchValue), [searchValue, sessions]);
  const visibleSessions = useMemo(() => hostGroups.flatMap((group) => group.sessions), [hostGroups]);
  const selectedSession = useMemo(
    () => visibleSessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, visibleSessions],
  );
  const selectedSessionIdValue = selectedSession?.id;
  const {
    data: selectedSessionDetail,
    error: sessionDetailError,
    isLoading: isSessionDetailLoading,
  } = useSessionDetail(selectedSessionIdValue);
  const sessionsErrorMessage = getOperationErrorMessage(
    sessionsError,
    t("sessionsPage.sessionsLoadError"),
  );

  useEffect(() => {
    setExpandedHosts((currentHosts) => reconcileExpandedKeys(currentHosts, hostGroups));
  }, [hostGroups]);

  useEffect(() => {
    const savedWidth = readStorageValue(EXPLORER_WIDTH_STORAGE_KEY);
    const parsedWidth = Number(savedWidth);
    const savedRequestCollapsed = readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true";

    if (Number.isFinite(parsedWidth)) {
      setExplorerWidth(clampExplorerWidth(parsedWidth));
    }

    setRequestCollapsed(savedRequestCollapsed);
  }, []);

  useEffect(() => {
    writeStorageValue(EXPLORER_WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    writeStorageValue(REQUEST_COLLAPSED_STORAGE_KEY, String(requestCollapsed));
  }, [requestCollapsed]);

  useEffect(() => {
    if (!clearSessionsMutation.isSuccess) {
      return;
    }

    setSelectedSessionId(undefined);
    setExpandedHosts([]);
  }, [clearSessionsMutation.isSuccess]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, []);

  function toggleHost(host: string) {
    setExpandedHosts((currentHosts) =>
      currentHosts.includes(host) ? currentHosts.filter((currentHost) => currentHost !== host) : [...currentHosts, host],
    );
  }

  const handleRepeat = useCallback(() => {
    if (!selectedSession) return;
    const bodyText = selectedSessionDetail?.requestBody?.inlineText;
    loadFromSession({
      method: selectedSession.method,
      url: selectedSession.url,
      headers: selectedSessionDetail?.requestHeaders ?? [],
      ...(bodyText ? { body: bodyText } : {}),
    });
    navigate("/compose");
  }, [selectedSession, selectedSessionDetail, loadFromSession, navigate]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const container = event.currentTarget.parentElement;

    if (!container) {
      return;
    }

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateWidth = (clientX: number) => {
      const bounds = container.getBoundingClientRect();
      const nextWidth = clampExplorerWidth(clientX - bounds.left);

      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }

      dragFrameRef.current = window.requestAnimationFrame(() => {
        setExplorerWidth(nextWidth);
      });
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  return (
    <Stack spacing={1} sx={{ height: "100%", minHeight: 0 }}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2} justifyContent="space-between">
        <Stack spacing={0.5}>
          <Typography variant="h4">{t("sessionsPage.title")}</Typography>
          <Typography color="text.secondary" variant="body2">
            {t("sessionsPage.description")}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadRoundedIcon />}
            onClick={() => setExportDialogOpen(true)}
            disabled={sessions.length === 0}
          >
            {t("sessionsPage.export")}
          </Button>
        </Stack>
      </Stack>

      {error ? (
        <Alert severity="error">
          {t("sessionsPage.runtimeError")}
        </Alert>
      ) : null}

      <Box
        sx={{
          display: "grid",
          flex: 1,
          gap: { lg: 1, xs: 1.5 },
          gridTemplateColumns: {
            lg: `${explorerWidth}px 8px minmax(0, 1fr)`,
            xs: "1fr",
          },
          minHeight: 0,
        }}
      >
        <SessionExplorerPane
          errorMessage={sessionsError ? sessionsErrorMessage : undefined}
          expandedHosts={expandedHosts}
          groups={hostGroups}
          isLoading={isLoading || areSessionsLoading}
          onSearchChange={setSearchValue}
          onSelectSession={setSelectedSessionId}
          onToggleHost={toggleHost}
          searchValue={searchValue}
          selectedSessionId={selectedSessionIdValue}
        />

        <Box
          aria-hidden
          onPointerDown={startResize}
          sx={{
            cursor: "col-resize",
            display: { lg: "flex", xs: "none" },
            justifyContent: "center",
            minHeight: 0,
            position: "relative",
            touchAction: "none",
            userSelect: "none",
            "&::before": {
              bgcolor: "divider",
              borderRadius: 999,
              content: '""',
              height: "100%",
              opacity: 0.7,
              transition: "background-color 120ms ease, opacity 120ms ease",
              width: 2,
            },
            "&:hover::before": {
              bgcolor: "primary.main",
              opacity: 1,
            },
          }}
        />

        <SessionInspectorWorkspace
          detailErrorMessage={
            sessionDetailError
              ? getOperationErrorMessage(
                  sessionDetailError,
                  t("sessionsPage.detailLoadError"),
                )
              : undefined
          }
          inspectorSplitRatio={DEFAULT_REQUEST_SPLIT_RATIO}
          isDetailLoading={isSessionDetailLoading}
          onRepeat={selectedSession ? handleRepeat : undefined}
          onRequestCollapsedChange={setRequestCollapsed}
          onRequestTabChange={setRequestInspectorTab}
          onResponseTabChange={setResponseInspectorTab}
          requestCollapsed={requestCollapsed}
          requestTab={requestInspectorTab}
          responseTab={responseInspectorTab}
          selectedSessionDetail={selectedSessionDetail}
          selectedSession={selectedSession}
        />
      </Box>

      <SessionExportDialog
        allSessions={sessions}
        filteredSessions={visibleSessions}
        onClose={() => setExportDialogOpen(false)}
        open={exportDialogOpen}
        selectedSession={selectedSession}
        selectedSessionDetail={selectedSessionDetail}
      />
    </Stack>
  );
}

function getOperationErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!error) {
    return fallbackMessage;
  }

  if (isAppError(error)) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  const coercedError = coerceAppError(error);

  return coercedError.message || fallbackMessage;
}

function readStorageValue(key: string): string | null {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return null;
  }

  return window.localStorage.getItem(key);
}

function writeStorageValue(key: string, value: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(key, value);
}

function clampExplorerWidth(width: number) {
  return Math.min(520, Math.max(280, Math.round(width)));
}
