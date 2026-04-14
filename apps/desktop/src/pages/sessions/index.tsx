import {
  coerceAppError,
  isAppError,
} from "@pharles/shared-types";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";
import { Alert, Box, Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Button, OutlinedInput } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useClearSessions, useDeleteSessionsExcept, useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { SessionContextMenu } from "@/features/sessions/components/SessionContextMenu";
import { SessionExportDialog } from "@/features/sessions/components/SessionExportDialog";
import { SessionExplorerPane } from "@/features/sessions/components/SessionExplorerPane";
import { SessionInspectorWorkspace } from "@/features/sessions/components/SessionInspectorWorkspace";
import type { WorkspaceHandle } from "@/features/sessions/components/SessionInspectorWorkspace";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import { buildSessionHostGroups, reconcileExpandedKeys } from "@/features/sessions/session-explorer.helpers";
import { getBodyText } from "@/features/sessions/session-export.helpers";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";
import { downloadTextFile } from "@/lib/download";
import { getSessionDetail, sendComposedRequest } from "@/services/commands";

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
  const deleteSessionsExceptMutation = useDeleteSessionsExcept();
  const dragFrameRef = useRef<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [searchValue, setSearchValue] = useState("");
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);
  const [requestInspectorTab, setRequestInspectorTab] = useState<RequestInspectorTab>("overview");
  const [responseInspectorTab, setResponseInspectorTab] = useState<ResponseInspectorTab>("overview");
  const [requestCollapsed, setRequestCollapsed] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(360);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Context menu state
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuSession, setContextMenuSession] = useState<SessionSummary | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  // Focus / Ignore state
  const [focusedHost, setFocusedHost] = useState<string | null>(null);
  const [ignoredHosts, setIgnoredHosts] = useState<Set<string>>(() => new Set());

  // Workspace ref for Cmd+F
  const workspaceRef = useRef<WorkspaceHandle>(null);

  // Filter out ignored hosts before grouping
  const filteredByIgnoreSessions = useMemo(() => {
    if (ignoredHosts.size === 0) return sessions;
    return sessions.filter((s) => !ignoredHosts.has(s.host));
  }, [sessions, ignoredHosts]);

  const hostGroups = useMemo(() => buildSessionHostGroups(filteredByIgnoreSessions, searchValue), [searchValue, filteredByIgnoreSessions]);
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

  // Cmd+F / Ctrl+F to activate inspector search
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        event.preventDefault();
        workspaceRef.current?.activateSearch();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  // --- Context menu handlers ---

  const handleContextMenu = useCallback((session: SessionSummary, event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuSession(session);
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuAnchor(undefined);
    setContextMenuSession(null);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
  }, []);

  const fetchDetailOnDemand = useCallback(async (session: SessionSummary): Promise<SessionDetail | undefined> => {
    if (selectedSessionDetail?.id === session.id) {
      return selectedSessionDetail;
    }
    try {
      return await getSessionDetail(session.id);
    } catch {
      return undefined;
    }
  }, [selectedSessionDetail]);

  const handleCopyUrl = useCallback((session: SessionSummary) => {
    void navigator.clipboard?.writeText(session.url);
    showSnackbar(t("contextMenu.copiedToClipboard"));
  }, [showSnackbar, t]);

  const handleCopyRequest = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const rawRequest = detail?.rawRequest;
    if (!rawRequest) return;
    await navigator.clipboard?.writeText(rawRequest);
    showSnackbar(t("contextMenu.copiedToClipboard"));
  }, [fetchDetailOnDemand, showSnackbar, t]);

  const handleCopyResponse = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const rawResponse = detail?.rawResponse;
    if (!rawResponse) return;
    await navigator.clipboard?.writeText(rawResponse);
    showSnackbar(t("contextMenu.copiedToClipboard"));
  }, [fetchDetailOnDemand, showSnackbar, t]);

  const handleSaveResponse = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const bodyText = getBodyText(detail?.responseBody);
    if (!bodyText) return;

    const mimeType = detail?.responseBody?.mimeType ?? "application/octet-stream";
    const extension = guessExtension(mimeType);
    const filename = `${session.host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${session.id.slice(0, 8)}.${extension}`;
    downloadTextFile(filename, bodyText, mimeType);
  }, [fetchDetailOnDemand]);

  const handleCompose = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const bodyText = detail?.requestBody?.inlineText;
    loadFromSession({
      method: session.method,
      url: session.url,
      headers: detail?.requestHeaders ?? [],
      ...(bodyText ? { body: bodyText } : {}),
    });
    navigate("/compose");
  }, [fetchDetailOnDemand, loadFromSession, navigate]);

  const handleRepeatDirect = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    if (!detail) return;
    const bodyText = detail.requestBody?.inlineText;
    try {
      await sendComposedRequest({
        workspaceId: "default",
        method: session.method,
        url: session.url,
        headers: detail.requestHeaders.map((h) => ({ name: h.name, value: h.value })),
        ...(bodyText ? { body: bodyText } : {}),
      });
    } catch {
      // Silent fail — the new session will appear via polling
    }
  }, [fetchDetailOnDemand]);

  const handleExportSession = useCallback((session: SessionSummary) => {
    setSelectedSessionId(session.id);
    setExportDialogOpen(true);
  }, []);

  const handleClearOthers = useCallback((session: SessionSummary) => {
    deleteSessionsExceptMutation.mutate(session.id);
    setSelectedSessionId(session.id);
  }, [deleteSessionsExceptMutation]);

  const handleGoToBreakpoints = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleGoToRules = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleFocusHost = useCallback((session: SessionSummary) => {
    setFocusedHost((prev) => prev === session.host ? null : session.host);
  }, []);

  const handleUnfocusHost = useCallback(() => {
    setFocusedHost(null);
  }, []);

  const handleIgnoreHost = useCallback((session: SessionSummary) => {
    setIgnoredHosts((prev) => {
      const next = new Set(prev);
      next.add(session.host);
      return next;
    });
  }, []);

  const handleStopIgnoringHost = useCallback((session: SessionSummary) => {
    setIgnoredHosts((prev) => {
      const next = new Set(prev);
      next.delete(session.host);
      return next;
    });
  }, []);

  // --- End context menu handlers ---

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
        <OutlinedInput
          fullWidth
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={t("sessionExplorer.searchPlaceholder")}
          size="small"
          startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
          sx={{
            maxWidth: { md: `${explorerWidth}px` },
          }}
          value={searchValue}
        />
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Button
            variant="outlined"
            size="small"
            onClick={() => clearSessionsMutation.mutate()}
            disabled={sessions.length === 0 || clearSessionsMutation.isPending}
          >
            {t("common.actions.clearSessions")}
          </Button>
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
          focusedHost={focusedHost}
          groups={hostGroups}
          isLoading={isLoading || areSessionsLoading}
          onContextMenuSession={handleContextMenu}
          onSelectSession={setSelectedSessionId}
          onToggleHost={toggleHost}
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
          ref={workspaceRef}
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

      <SessionContextMenu
        anchorPosition={contextMenuAnchor}
        isHostFocused={contextMenuSession?.host === focusedHost}
        isHostIgnored={contextMenuSession ? ignoredHosts.has(contextMenuSession.host) : false}
        onClose={handleContextMenuClose}
        onClearOthers={handleClearOthers}
        onCompose={handleCompose}
        onCopyRequest={handleCopyRequest}
        onCopyResponse={handleCopyResponse}
        onCopyUrl={handleCopyUrl}
        onExportSession={handleExportSession}
        onFocusHost={handleFocusHost}
        onGoToBreakpoints={handleGoToBreakpoints}
        onGoToRules={handleGoToRules}
        onIgnoreHost={handleIgnoreHost}
        onRepeat={handleRepeatDirect}
        onSaveResponse={handleSaveResponse}
        onStopIgnoringHost={handleStopIgnoringHost}
        onUnfocusHost={handleUnfocusHost}
        session={contextMenuSession}
      />

      <Snackbar
        anchorOrigin={{ horizontal: "center", vertical: "bottom" }}
        autoHideDuration={2000}
        onClose={() => setSnackbarMessage(null)}
        open={snackbarMessage !== null}
        message={snackbarMessage}
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

function guessExtension(mimeType: string): string {
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("xml")) return "xml";
  if (mimeType.includes("javascript")) return "js";
  if (mimeType.includes("css")) return "css";
  if (mimeType.includes("text")) return "txt";
  if (mimeType.includes("image/png")) return "png";
  if (mimeType.includes("image/jpeg") || mimeType.includes("image/jpg")) return "jpg";
  if (mimeType.includes("image/svg")) return "svg";
  if (mimeType.includes("image/gif")) return "gif";
  if (mimeType.includes("image/")) return "bin";
  return "txt";
}
