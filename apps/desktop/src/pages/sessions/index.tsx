import {
  coerceAppError,
  isAppError,
} from "@aiproxy/shared-types";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import { Alert, Box, Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/AppShell";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { DomainContextMenu } from "@/features/sessions/components/DomainContextMenu";
import { SessionContainerTabs } from "@/features/sessions/components/SessionContainerTabs";
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
import {
  clearActiveSessionContainer,
  clearOtherSessionsInActiveContainer,
  closeSessionContainer,
  createAdditionalSessionContainer,
  createInitialSessionContainerState,
  getSessionContainerById,
  removeSessionContainerSummary,
  seedSessionContainers,
  setActiveSessionContainer,
  updateActiveSessionContainer,
  upsertSessionContainerSummary,
} from "@/features/sessions/session-containers.helpers";
import { buildSessionHostGroups, reconcileExpandedKeys } from "@/features/sessions/session-explorer.helpers";
import { buildCurlCommand, getBodyText } from "@/features/sessions/session-export.helpers";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessionEvents } from "@/features/sessions/use-session-events";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";
import { downloadTextFile } from "@/lib/download";
import { onSessionRemove, onSessionUpsert } from "@/services/events";
import { getSessionDetail, setFocusedHost as syncFocusedHost } from "@/services/commands";

const EXPLORER_WIDTH_STORAGE_KEY = "aiproxy.sessions.explorerWidth";
const REQUEST_COLLAPSED_STORAGE_KEY = "aiproxy.sessions.requestCollapsed";
const FOCUSED_HOST_STORAGE_KEY = "aiproxy.sessions.focusedHost";
const IGNORED_HOSTS_STORAGE_KEY = "aiproxy.sessions.ignoredHosts";

export function SessionsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();
  const loadFromSession = useComposeEditorStore((s) => s.loadFromSession);
  const sendComposedRequestMutation = useSendComposedRequest();
  const { error, isLoading } = useProxyStatus();
  const {
    data: runtimeSessions = [],
    error: sessionsError,
    isLoading: areSessionsLoading,
  } = useSessions();
  const dragFrameRef = useRef<number | null>(null);
  const [containerState, setContainerState] = useState(() =>
    createInitialSessionContainerState({
      requestCollapsed: readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
      requestTab: "headers",
      responseTab: "overview",
    }),
  );
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const savedWidth = readStorageValue(EXPLORER_WIDTH_STORAGE_KEY);
    const parsedWidth = Number(savedWidth);

    return Number.isFinite(parsedWidth) ? clampExplorerWidth(parsedWidth) : 360;
  });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Context menu state
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuSession, setContextMenuSession] = useState<SessionSummary | null>(null);
  const [domainContextMenuAnchor, setDomainContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuHost, setContextMenuHost] = useState<string | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  // Focus / Ignore state
  const [focusedHost, setFocusedHost] = useState<string | null>(() => normalizeStoredHost(readStorageValue(FOCUSED_HOST_STORAGE_KEY)));
  const [ignoredHosts, setIgnoredHosts] = useState<Set<string>>(() => new Set(readStoredHosts(IGNORED_HOSTS_STORAGE_KEY)));

  // Workspace ref for Cmd+F
  const workspaceRef = useRef<WorkspaceHandle>(null);

  useSessionEvents();

  const activeContainer =
    getSessionContainerById(containerState, containerState.activeContainerId) ??
    containerState.containers[0];

  const activeSessions = useMemo(
    () =>
      (activeContainer?.sessionIds ?? [])
        .map((sessionId) => containerState.sessionSummaryById[sessionId])
        .filter((session): session is SessionSummary => Boolean(session)),
    [activeContainer?.sessionIds, containerState.sessionSummaryById],
  );

  // Filter out ignored hosts before grouping
  const filteredByIgnoreSessions = useMemo(() => {
    if (ignoredHosts.size === 0) return activeSessions;
    return activeSessions.filter((s) => !ignoredHosts.has(s.host));
  }, [activeSessions, ignoredHosts]);

  const hostGroups = useMemo(
    () => buildSessionHostGroups(filteredByIgnoreSessions, activeContainer?.searchValue ?? "", {
      focusedHost,
      unfocusedLabel: t("sessionExplorer.unfocusedGroup"),
    }),
    [activeContainer?.searchValue, filteredByIgnoreSessions, focusedHost, t],
  );
  const visibleSessions = useMemo(() => hostGroups.flatMap((group) => group.sessions), [hostGroups]);
  const selectedSession = useMemo(
    () => visibleSessions.find((session) => session.id === activeContainer?.selectedSessionId),
    [activeContainer?.selectedSessionId, visibleSessions],
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
    if (areSessionsLoading) {
      return;
    }

    setContainerState((currentState) =>
      currentState.hydrated ? currentState : seedSessionContainers(currentState, runtimeSessions),
    );
  }, [areSessionsLoading, runtimeSessions]);

  useEffect(() => {
    const unlistenFns: Array<() => void> = [];

    onSessionUpsert((detail) => {
      setContainerState((currentState) => upsertSessionContainerSummary(currentState, detail.summary));
    }).then((fn) => {
      unlistenFns.push(fn);
    });

    onSessionRemove((sessionId) => {
      setContainerState((currentState) => removeSessionContainerSummary(currentState, sessionId));
    }).then((fn) => {
      unlistenFns.push(fn);
    });

    return () => {
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, []);

  useEffect(() => {
    writeStorageValue(EXPLORER_WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    writeStorageValue(REQUEST_COLLAPSED_STORAGE_KEY, String(activeContainer?.requestCollapsed ?? false));
  }, [activeContainer?.requestCollapsed]);

  useEffect(() => {
    if (focusedHost) {
      writeStorageValue(FOCUSED_HOST_STORAGE_KEY, focusedHost);
      return;
    }

    removeStorageValue(FOCUSED_HOST_STORAGE_KEY);
  }, [focusedHost]);

  useEffect(() => {
    void syncFocusedHost(focusedHost).catch(() => {
      // Session focus is a best-effort optimization for Rust-side eviction.
    });
  }, [focusedHost]);

  useEffect(() => {
    if (ignoredHosts.size === 0) {
      removeStorageValue(IGNORED_HOSTS_STORAGE_KEY);
      return;
    }

    writeStorageValue(IGNORED_HOSTS_STORAGE_KEY, JSON.stringify(Array.from(ignoredHosts)));
  }, [ignoredHosts]);

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

  useEffect(() => {
    setContainerState((currentState) => {
      const currentContainer = getSessionContainerById(currentState, currentState.activeContainerId);

      if (!currentContainer) {
        return currentState;
      }

      const nextExpandedHosts = reconcileExpandedKeys(currentContainer.expandedHosts, hostGroups);

      if (areStringArraysEqual(nextExpandedHosts, currentContainer.expandedHosts)) {
        return currentState;
      }

      return updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        expandedHosts: nextExpandedHosts,
      }));
    });
  }, [hostGroups]);

  function toggleHost(host: string) {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        expandedHosts: container.expandedHosts.includes(host)
          ? container.expandedHosts.filter((currentHost) => currentHost !== host)
          : [...container.expandedHosts, host],
      })),
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
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
    setContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuSession(session);
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuAnchor(undefined);
    setContextMenuSession(null);
  }, []);

  const handleHostContextMenu = useCallback((host: string, event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenuAnchor(undefined);
    setContextMenuSession(null);
    setDomainContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuHost(host);
  }, []);

  const handleHostContextMenuClose = useCallback(() => {
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
  }, []);

  const copyToClipboard = useCallback(async (text: string, message: string) => {
    if (!text) {
      return;
    }

    await navigator.clipboard?.writeText(text);
    showSnackbar(message);
  }, [showSnackbar]);

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
    void copyToClipboard(session.url, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, t]);

  const handleCopyRequest = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const rawRequest = detail?.rawRequest;
    if (!rawRequest) return;
    await copyToClipboard(rawRequest, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, fetchDetailOnDemand, t]);

  const handleCopyCurl = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    if (!detail) return;
    await copyToClipboard(buildCurlCommand(detail), t("composePage.copiedCurl"));
  }, [copyToClipboard, fetchDetailOnDemand, t]);

  const handleCopyResponse = useCallback(async (session: SessionSummary) => {
    const detail = await fetchDetailOnDemand(session);
    const rawResponse = detail?.rawResponse;
    if (!rawResponse) return;
    await copyToClipboard(rawResponse, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, fetchDetailOnDemand, t]);

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
      await sendComposedRequestMutation.mutateAsync({
        workspaceId: "default",
        method: session.method,
        url: session.url,
        headers: detail.requestHeaders.map((h) => ({ name: h.name, value: h.value })),
        ...(bodyText ? { body: bodyText } : {}),
      });
    } catch {
      // Silent fail — the new session will appear via polling
    }
  }, [fetchDetailOnDemand, sendComposedRequestMutation]);

  const handleExportSession = useCallback((session: SessionSummary) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        selectedSessionId: session.id,
      })),
    );
    setExportDialogOpen(true);
  }, []);

  const handleClearOthers = useCallback((session: SessionSummary) => {
    setContainerState((currentState) => clearOtherSessionsInActiveContainer(currentState, session.id));
  }, []);

  const handleGoToBreakpoints = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleGoToRules = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleFocusDomain = useCallback((host: string) => {
    setFocusedHost((prev) => prev === host ? null : host);
  }, []);

  const handleUnfocusHost = useCallback(() => {
    setFocusedHost(null);
  }, []);

  const handleIgnoreDomain = useCallback((host: string) => {
    setFocusedHost((prev) => prev === host ? null : prev);
    setIgnoredHosts((prev) => {
      const next = new Set(prev);
      next.add(host);
      return next;
    });
  }, []);

  const handleStopIgnoringDomain = useCallback((host: string) => {
    setIgnoredHosts((prev) => {
      const next = new Set(prev);
      next.delete(host);
      return next;
    });
  }, []);

  const handleFocusHost = useCallback((session: SessionSummary) => {
    handleFocusDomain(session.host);
  }, [handleFocusDomain]);

  const handleIgnoreHost = useCallback((session: SessionSummary) => {
    handleIgnoreDomain(session.host);
  }, [handleIgnoreDomain]);

  const handleStopIgnoringHost = useCallback((session: SessionSummary) => {
    handleStopIgnoringDomain(session.host);
  }, [handleStopIgnoringDomain]);

  // --- End context menu handlers ---

  const handleAddContainer = useCallback(() => {
    setContainerState((currentState) => createAdditionalSessionContainer(currentState));
  }, []);

  const handleSelectContainer = useCallback((containerId: string) => {
    setContainerState((currentState) => setActiveSessionContainer(currentState, containerId));
  }, []);

  const handleCloseContainer = useCallback((containerId: string) => {
    setContainerState((currentState) => closeSessionContainer(currentState, containerId));
  }, []);

  const handleSelectedSessionChange = useCallback((sessionId: string) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        selectedSessionId: sessionId,
      })),
    );
  }, []);

  const handleRequestTabChange = useCallback((tab: RequestInspectorTab) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        requestTab: tab,
      })),
    );
  }, []);

  const handleResponseTabChange = useCallback((tab: ResponseInspectorTab) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        responseTab: tab,
      })),
    );
  }, []);

  const handleRequestCollapsedChange = useCallback((collapsed: boolean) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        requestCollapsed: collapsed,
      })),
    );
  }, []);

  const handleClearActiveContainer = useCallback(() => {
    setContainerState((currentState) => clearActiveSessionContainer(currentState));
  }, []);

  const headerActions = useMemo(
    () => (
      <Stack
        direction="row"
        spacing={1.25}
        sx={{
          flexWrap: "wrap",
        }}
      >
        <TopBarActionButton
          onClick={handleClearActiveContainer}
          disabled={activeSessions.length === 0}
          icon={<DeleteSweepRoundedIcon />}
          label={t("sessionsPage.containers.clearCurrent")}
        />
        <TopBarActionButton
          onClick={() => setExportDialogOpen(true)}
          disabled={activeSessions.length === 0}
          icon={<DownloadRoundedIcon />}
          label={t("sessionsPage.export")}
        />
      </Stack>
    ),
    [activeSessions.length, handleClearActiveContainer, t],
  );

  useLayoutEffect(() => {
    setHeaderActions(headerActions);

    return () => {
      setHeaderActions(null);
    };
  }, [headerActions, setHeaderActions]);

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
    <Stack spacing={0.75} sx={{ height: "100%", minHeight: 0, mt: -0.5 }}>
      <SessionContainerTabs
        containers={containerState.containers.map((container) => ({
          id: container.id,
          isActive: container.id === containerState.activeContainerId,
          labelNumber: container.labelNumber,
        }))}
        onAddContainer={handleAddContainer}
        onCloseContainer={handleCloseContainer}
        onSelectContainer={handleSelectContainer}
      />

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
          expandedHosts={activeContainer?.expandedHosts ?? []}
          groups={hostGroups}
          isLoading={isLoading || areSessionsLoading}
          onContextMenuHost={handleHostContextMenu}
          onContextMenuSession={handleContextMenu}
          onSelectSession={handleSelectedSessionChange}
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
          onCopyCurl={selectedSession ? () => { void handleCopyCurl(selectedSession); } : undefined}
          onCopyRequest={selectedSession ? () => { void handleCopyRequest(selectedSession); } : undefined}
          onCopyUrl={selectedSession ? () => { handleCopyUrl(selectedSession); } : undefined}
          onRepeat={selectedSession ? handleRepeat : undefined}
          onRequestCollapsedChange={handleRequestCollapsedChange}
          onRequestTabChange={handleRequestTabChange}
          onResponseTabChange={handleResponseTabChange}
          requestCollapsed={activeContainer?.requestCollapsed ?? false}
          requestTab={activeContainer?.requestTab ?? "headers"}
          responseTab={activeContainer?.responseTab ?? "overview"}
          selectedSessionDetail={selectedSessionDetail}
          selectedSession={selectedSession}
        />
      </Box>

      <SessionExportDialog
        allSessions={activeSessions}
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
        onCopyCurl={handleCopyCurl}
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

      <DomainContextMenu
        anchorPosition={domainContextMenuAnchor}
        host={contextMenuHost}
        isHostFocused={contextMenuHost === focusedHost}
        isHostIgnored={contextMenuHost ? ignoredHosts.has(contextMenuHost) : false}
        onClose={handleHostContextMenuClose}
        onFocusHost={handleFocusDomain}
        onIgnoreHost={handleIgnoreDomain}
        onStopIgnoringHost={handleStopIgnoringDomain}
        onUnfocusHost={handleUnfocusHost}
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

function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
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

function removeStorageValue(key: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.removeItem !== "function") {
    return;
  }

  window.localStorage.removeItem(key);
}

function normalizeStoredHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : null;
}

function readStoredHosts(key: string): string[] {
  const rawValue = readStorageValue(key);

  if (!rawValue) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(rawValue);

    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return Array.from(
      new Set(
        parsedValue
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );
  } catch {
    return [];
  }
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
