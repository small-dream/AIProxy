import {
  coerceAppError,
  isAppError,
} from "@aiproxy/shared-types";
import type { SessionSummary } from "@aiproxy/shared-types";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import { Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/AppShell";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useClearSessions } from "@/features/proxy-status/use-proxy-status";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { DomainContextMenu } from "@/features/sessions/components/DomainContextMenu";
import { SessionContextMenu } from "@/features/sessions/components/SessionContextMenu";
import { SessionExportDialog } from "@/features/sessions/components/SessionExportDialog";
import type { WorkspaceHandle } from "@/features/sessions/components/SessionInspectorWorkspace";
import { SessionsWorkspacePanel } from "@/features/sessions/components/SessionsWorkspacePanel";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import {
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
import {
  buildSessionHostGroups,
  filterSessionsByHostKeyword,
  reconcileExpandedKeys,
} from "@/features/sessions/session-explorer.helpers";
import {
  normalizeStoredHost,
  readStorageValue,
  readStoredHosts,
  removeStorageValue,
  writeStorageValue,
} from "@/features/sessions/session-ui.helpers";
import { useSessionContextActions } from "@/features/sessions/use-session-context-actions";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessionEvents } from "@/features/sessions/use-session-events";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";
import { onSessionRemove, onSessionUpsert } from "@/services/events";
import { setFocusedHost as syncFocusedHost } from "@/services/commands";

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
  const { mutate: clearSessions, isPending: isClearingSessions } = useClearSessions();
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
  const [focusedHost, setFocusedHost] = useState<string | null>(() =>
    normalizeStoredHost(readStorageValue(FOCUSED_HOST_STORAGE_KEY)),
  );
  const [ignoredHosts, setIgnoredHosts] = useState<Set<string>>(
    () => new Set(readStoredHosts(IGNORED_HOSTS_STORAGE_KEY)),
  );

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

  const {
    contextMenuAnchor,
    contextMenuHost,
    contextMenuSession,
    domainContextMenuAnchor,
    snackbarMessage,
    handleCompose,
    handleContextMenu,
    handleContextMenuClose,
    handleCopyCurl,
    handleCopyRequest,
    handleCopyResponse,
    handleCopyUrl,
    handleFocusDomain,
    handleFocusHost,
    handleHostContextMenu,
    handleHostContextMenuClose,
    handleIgnoreDomain,
    handleIgnoreHost,
    handleRepeatDirect,
    handleSaveResponse,
    handleSnackbarClose,
    handleStopIgnoringDomain,
    handleStopIgnoringHost,
    handleUnfocusHost,
  } = useSessionContextActions({
    loadFromSession,
    navigate,
    setFocusedHost,
    setIgnoredHosts,
    sendComposedRequest: sendComposedRequestMutation,
  });
  const filteredByIgnoreSessions = useMemo(() => {
    if (ignoredHosts.size === 0) {
      return activeSessions;
    }

    return activeSessions.filter((session) => !ignoredHosts.has(session.host));
  }, [activeSessions, ignoredHosts]);
  const domainFilteredSessions = useMemo(
    () => filterSessionsByHostKeyword(filteredByIgnoreSessions, activeContainer?.domainFilterValue ?? ""),
    [activeContainer?.domainFilterValue, filteredByIgnoreSessions],
  );
  const hostGroups = useMemo(
    () => buildSessionHostGroups(domainFilteredSessions, activeContainer?.searchValue ?? "", {
      focusedHost,
      unfocusedLabel: t("sessionExplorer.unfocusedGroup"),
    }),
    [activeContainer?.searchValue, domainFilteredSessions, focusedHost, t],
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
    if (!selectedSession) {
      return;
    }

    void handleCompose(selectedSession);
  }, [handleCompose, selectedSession]);

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

  const handleDomainFilterChange = useCallback((value: string) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        domainFilterValue: value,
      })),
    );
  }, []);

  const handleClearActiveContainer = useCallback(() => {
    clearSessions(undefined, {
      onSuccess: () => {
        setContainerState((currentState) =>
          createInitialSessionContainerState({
            requestCollapsed:
              getSessionContainerById(currentState, currentState.activeContainerId)?.requestCollapsed
              ?? readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
            requestTab:
              getSessionContainerById(currentState, currentState.activeContainerId)?.requestTab ?? "headers",
            responseTab:
              getSessionContainerById(currentState, currentState.activeContainerId)?.responseTab ?? "overview",
          }),
        );
      },
    });
  }, [clearSessions]);

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
          disabled={activeSessions.length === 0 || isClearingSessions}
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
    [activeSessions.length, handleClearActiveContainer, isClearingSessions, t],
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
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <SessionsWorkspacePanel
        activeContainerId={containerState.activeContainerId}
        containerTabs={containerState.containers.map((container) => ({
          id: container.id,
          labelNumber: container.labelNumber,
        }))}
        detailErrorMessage={
          sessionDetailError
            ? getOperationErrorMessage(
                sessionDetailError,
                t("sessionsPage.detailLoadError"),
              )
            : undefined
        }
        domainFilterValue={activeContainer?.domainFilterValue ?? ""}
        errorMessage={sessionsError ? sessionsErrorMessage : undefined}
        expandedHosts={activeContainer?.expandedHosts ?? []}
        explorerWidth={explorerWidth}
        groups={hostGroups}
        inspectorSplitRatio={DEFAULT_REQUEST_SPLIT_RATIO}
        isDetailLoading={isSessionDetailLoading}
        isLoading={isLoading || areSessionsLoading}
        onAddContainer={handleAddContainer}
        onCloseContainer={handleCloseContainer}
        onContextMenuHost={handleHostContextMenu}
        onContextMenuSession={handleContextMenu}
        onCopyCurl={selectedSession ? () => { void handleCopyCurl(selectedSession); } : undefined}
        onCopyRequest={selectedSession ? () => { void handleCopyRequest(selectedSession); } : undefined}
        onCopyUrl={selectedSession ? () => { handleCopyUrl(selectedSession); } : undefined}
        onDomainFilterChange={handleDomainFilterChange}
        onRepeat={selectedSession ? handleRepeat : undefined}
        onRequestCollapsedChange={handleRequestCollapsedChange}
        onRequestTabChange={handleRequestTabChange}
        onResizeStart={startResize}
        onResponseTabChange={handleResponseTabChange}
        onSelectContainer={handleSelectContainer}
        onSelectSession={handleSelectedSessionChange}
        onToggleHost={toggleHost}
        requestCollapsed={activeContainer?.requestCollapsed ?? false}
        requestTab={activeContainer?.requestTab ?? "headers"}
        responseTab={activeContainer?.responseTab ?? "overview"}
        runtimeErrorMessage={error ? t("sessionsPage.runtimeError") : undefined}
        selectedSession={selectedSession}
        selectedSessionDetail={selectedSessionDetail}
        selectedSessionId={selectedSessionIdValue}
        workspaceRef={workspaceRef}
      />

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
        onClose={handleSnackbarClose}
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

function clampExplorerWidth(width: number) {
  return Math.min(520, Math.max(280, Math.round(width)));
}
