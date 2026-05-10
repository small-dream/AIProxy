import {
  coerceAppError,
  isAppError,
  type SessionDetail,
} from "@aiproxy/shared-types";
import type { SessionSummary } from "@aiproxy/shared-types";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import { Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useClearSessions } from "@/features/proxy-status/use-proxy-status";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { DomainContextMenu } from "@/features/sessions/components/DomainContextMenu";
import { SessionContextMenu } from "@/features/sessions/components/SessionContextMenu";
import { SaveToCollectionDialog } from "@/features/collections/components/SaveToCollectionDialog";
import {
  SessionExportDialog,
  type SessionExportDialogScope,
  type SessionExportHostScope,
} from "@/features/sessions/components/SessionExportDialog";
import type { WorkspaceHandle } from "@/features/sessions/components/SessionInspectorWorkspace";
import { SessionsWorkspacePanel } from "@/features/sessions/components/SessionsWorkspacePanel";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  clampInspectorSplitRatio,
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
import { upsertImportedSessions } from "@/features/sessions/imported-sessions.store";
import { upsertSessionSummary } from "@/features/sessions/session-cache.helpers";
import {
  buildSessionHostGroups,
  filterSessionsByHostKeyword,
  reconcileExpandedKeys,
} from "@/features/sessions/session-explorer.helpers";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { buildHarArchive, buildHarExportFilename } from "@/features/sessions/session-export.helpers";
import { parseHarArchive } from "@/features/sessions/session-import.helpers";
import { readSessionsMenuAction } from "@/features/sessions/session-menu-actions";
import {
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
import { downloadTextFile } from "@/lib/download";
import { onSessionRemove, onSessionsCleared, onSessionsRemoved, onSessionUpsert } from "@/services/events";
import { readHarFile, setFocusedHosts as syncFocusedHosts } from "@/services/commands";

const EXPLORER_WIDTH_STORAGE_KEY = "aiproxy.sessions.explorerWidth";
const EXPANDED_HOSTS_STORAGE_KEY = "aiproxy.sessions.expandedHosts";
const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.sessions.inspectorSplitRatio";
const REQUEST_COLLAPSED_STORAGE_KEY = "aiproxy.sessions.requestCollapsed";
const SELECTED_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.selectedSessionId";
const FOCUSED_HOSTS_STORAGE_KEY = "aiproxy.sessions.focusedHosts";
const IGNORED_HOSTS_STORAGE_KEY = "aiproxy.sessions.ignoredHosts";

export function SessionsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();
  const loadFromSession = useComposeEditorStore((s) => s.loadFromSession);
  const { mutate: clearSessions, isPending: isClearingSessions } = useClearSessions();
  const { error, isLoading } = useProxyStatus();
  const {
    data: runtimeSessions = [],
    error: sessionsError,
    isLoading: areSessionsLoading,
  } = useSessions();
  const explorerDragFrameRef = useRef<number | null>(null);
  const inspectorDragFrameRef = useRef<number | null>(null);
  const defaultInspectorSplitRatio = useMemo(() => {
    const savedRatio = Number(readStorageValue(INSPECTOR_SPLIT_RATIO_STORAGE_KEY));

    return Number.isFinite(savedRatio)
      ? clampInspectorSplitRatio(savedRatio)
      : DEFAULT_REQUEST_SPLIT_RATIO;
  }, []);
  const [containerState, setContainerState] = useState(() => {
    const storedSessionId = readStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
    return createInitialSessionContainerState({
      expandedHosts: readStoredHosts(EXPANDED_HOSTS_STORAGE_KEY),
      inspectorSplitRatio: defaultInspectorSplitRatio,
      requestCollapsed: readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
      requestTab: "query",
      responseTab: "overview",
      ...(storedSessionId ? { selectedSessionId: storedSessionId } : {}),
    });
  });
  const [explorerWidth, setExplorerWidth] = useState(() => {
    const savedWidth = readStorageValue(EXPLORER_WIDTH_STORAGE_KEY);
    const parsedWidth = Number(savedWidth);

    return Number.isFinite(parsedWidth) ? clampExplorerWidth(parsedWidth) : 360;
  });
  const lastHandledMenuActionRef = useRef(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDialogInitialScope, setExportDialogInitialScope] = useState<SessionExportDialogScope>();
  const [exportDialogHostScope, setExportDialogHostScope] = useState<SessionExportHostScope | null>(null);
  const [importSnackbarMessage, setImportSnackbarMessage] = useState<string | null>(null);
  const [focusedHosts, setFocusedHosts] = useState<Set<string>>(() =>
    readFocusedHostsFromStorage(),
  );
  const [ignoredHosts, setIgnoredHosts] = useState<Set<string>>(
    () => new Set(readStoredHosts(IGNORED_HOSTS_STORAGE_KEY)),
  );
  const [sessionSelectionNonce, setSessionSelectionNonce] = useState(0);

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
    handleSaveToCollection,
    handleSaveToCollectionCancel,
    handleSaveToCollectionConfirm,
    handleSnackbarClose,
    handleStopIgnoringDomain,
    handleStopIgnoringHost,
    handleUnfocusDomain,
    handleUnfocusHost,
    saveToCollectionSession,
  } = useSessionContextActions({
    loadFromSession,
    navigate,
    setFocusedHosts,
    setIgnoredHosts,
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
      focusedHosts,
      unfocusedLabel: t("sessionExplorer.unfocusedGroup"),
    }),
    [activeContainer?.searchValue, domainFilteredSessions, focusedHosts, t],
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
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    let upsertBuffer: SessionSummary[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushUpsertBuffer() {
      if (upsertBuffer.length === 0) return;
      const batch = upsertBuffer;
      upsertBuffer = [];
      flushTimer = null;

      setContainerState((currentState) => {
        let next = currentState;
        for (const summary of batch) {
          next = upsertSessionContainerSummary(next, summary);
        }
        return next;
      });
    }

    onSessionUpsert((summary) => {
      if (cancelled) return;
      upsertBuffer.push(summary);

      if (!flushTimer) {
        flushTimer = setTimeout(flushUpsertBuffer, 100);
      }
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionRemove((sessionId) => {
      if (cancelled) return;
      setContainerState((currentState) => removeSessionContainerSummary(currentState, sessionId));
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionsCleared(() => {
      if (cancelled) return;
      upsertBuffer = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      removeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
      setContainerState((currentState) =>
        createInitialSessionContainerState({
          inspectorSplitRatio:
            getSessionContainerById(currentState, currentState.activeContainerId)?.inspectorSplitRatio
            ?? defaultInspectorSplitRatio,
          requestCollapsed:
            getSessionContainerById(currentState, currentState.activeContainerId)?.requestCollapsed
            ?? readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
          requestTab:
            getSessionContainerById(currentState, currentState.activeContainerId)?.requestTab ?? "headers",
          responseTab:
            getSessionContainerById(currentState, currentState.activeContainerId)?.responseTab ?? "overview",
        }),
      );
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionsRemoved((ids) => {
      if (cancelled) return;
      setContainerState((currentState) => {
        let nextState = currentState;
        for (const id of ids) {
          nextState = removeSessionContainerSummary(nextState, id);
        }
        return nextState;
      });
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    return () => {
      cancelled = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushUpsertBuffer();
      }
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [defaultInspectorSplitRatio]);

  useEffect(() => {
    writeStorageValue(EXPLORER_WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    const expandedHosts = activeContainer?.expandedHosts ?? [];

    if (expandedHosts.length === 0) {
      removeStorageValue(EXPANDED_HOSTS_STORAGE_KEY);
      return;
    }

    writeStorageValue(EXPANDED_HOSTS_STORAGE_KEY, JSON.stringify(expandedHosts));
  }, [activeContainer?.expandedHosts]);

  useEffect(() => {
    writeStorageValue(
      INSPECTOR_SPLIT_RATIO_STORAGE_KEY,
      String(activeContainer?.inspectorSplitRatio ?? defaultInspectorSplitRatio),
    );
  }, [activeContainer?.inspectorSplitRatio, defaultInspectorSplitRatio]);

  useEffect(() => {
    writeStorageValue(REQUEST_COLLAPSED_STORAGE_KEY, String(activeContainer?.requestCollapsed ?? false));
  }, [activeContainer?.requestCollapsed]);

  useEffect(() => {
    if (focusedHosts.size > 0) {
      writeStorageValue(FOCUSED_HOSTS_STORAGE_KEY, JSON.stringify(Array.from(focusedHosts)));
      return;
    }

    removeStorageValue(FOCUSED_HOSTS_STORAGE_KEY);
  }, [focusedHosts]);

  useEffect(() => {
    void syncFocusedHosts(Array.from(focusedHosts)).catch(() => {
      // Session focus is a best-effort optimization for Rust-side eviction.
    });
  }, [focusedHosts]);

  useEffect(() => {
    if (ignoredHosts.size === 0) {
      removeStorageValue(IGNORED_HOSTS_STORAGE_KEY);
      return;
    }

    writeStorageValue(IGNORED_HOSTS_STORAGE_KEY, JSON.stringify(Array.from(ignoredHosts)));
  }, [ignoredHosts]);

  useEffect(() => {
    return () => {
      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }

      if (inspectorDragFrameRef.current) {
        window.cancelAnimationFrame(inspectorDragFrameRef.current);
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
    if (!containerState.hydrated) {
      return;
    }

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
  }, [containerState.hydrated, hostGroups]);

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

  const handleRepeatSession = useCallback((session: SessionSummary) => {
    const selectRepeatedSummary = (summary: SessionSummary) => {
      setContainerState((currentState) =>
        updateActiveSessionContainer(upsertSessionContainerSummary(currentState, summary), (container) => ({
          ...container,
          selectedSessionId: summary.id,
        })),
      );
      setSessionSelectionNonce((currentValue) => currentValue + 1);
    };

    void handleRepeatDirect(session, {
      onFailure: (pendingSessionId) => {
        setContainerState((currentState) =>
          updateActiveSessionContainer(
            removeSessionContainerSummary(currentState, pendingSessionId),
            (container) =>
              container.selectedSessionId === pendingSessionId
                ? {
                    ...container,
                    selectedSessionId: session.id,
                  }
                : container,
          ),
        );
      },
      onPending: selectRepeatedSummary,
      onSuccess: (pendingSessionId, summary) => {
        setContainerState((currentState) =>
          updateActiveSessionContainer(
            upsertSessionContainerSummary(
              removeSessionContainerSummary(currentState, pendingSessionId),
              summary,
            ),
            (container) => ({
              ...container,
              selectedSessionId: summary.id,
            }),
          ),
        );
        setSessionSelectionNonce((currentValue) => currentValue + 1);
      },
    });
  }, [handleRepeatDirect]);

  const handleRepeat = useCallback(() => {
    if (!selectedSession) {
      return;
    }

    handleRepeatSession(selectedSession);
  }, [handleRepeatSession, selectedSession]);

  const handleExportSession = useCallback((session: SessionSummary) => {
    void exportSessionsAsHar(queryClient, [session], buildHarExportFilename("request", session.host))
      .catch((error) => {
        setImportSnackbarMessage(error instanceof Error ? error.message : t("common.errors.unexpected"));
      });
  }, [queryClient, t]);

  const handleOpenExportDialog = useCallback((scope?: SessionExportDialogScope) => {
    setExportDialogHostScope(null);
    setExportDialogInitialScope(scope);
    setExportDialogOpen(true);
  }, []);

  const handleExportHost = useCallback((host: string) => {
    const hostSessions = visibleSessions.filter((session) => session.host === host);
    void exportSessionsAsHar(queryClient, hostSessions, buildHarExportFilename("host", host))
      .catch((error) => {
        setImportSnackbarMessage(error instanceof Error ? error.message : t("common.errors.unexpected"));
      });
  }, [queryClient, t, visibleSessions]);

  const handleImportSessions = useCallback((details: SessionDetail[]) => {
    if (details.length === 0) {
      return;
    }

    upsertImportedSessions(details);

    queryClient.setQueryData<SessionSummary[]>(["sessions"], (currentSessions = []) => {
      let nextSessions = currentSessions;

      for (const detail of details) {
        nextSessions = upsertSessionSummary(nextSessions, detail.summary);
      }

      return nextSessions;
    });

    for (const detail of details) {
      queryClient.setQueryData(["session-detail", detail.id], detail);
    }

    setContainerState((currentState) => {
      let nextState = currentState;

      for (const detail of details) {
        nextState = upsertSessionContainerSummary(nextState, detail.summary);
      }

      return updateActiveSessionContainer(nextState, (container) => ({
        ...container,
        ...(details[0]?.id ? { selectedSessionId: details[0].id } : {}),
      }));
    });

    setSessionSelectionNonce((currentValue) => currentValue + 1);
    setImportSnackbarMessage(t("sessionsImport.messages.importedHar", {
      count: details.length,
    }));
  }, [queryClient, t]);

  const handleImportHarPickerOpen = useCallback(async () => {
    try {
      const selected = await open({
        directory: false,
        filters: [{ name: "HAR", extensions: ["har"] }],
        multiple: false,
        title: t("sessionsImport.title"),
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      if (!selected.toLowerCase().endsWith(".har")) {
        throw new Error(t("sessionsImport.invalidFileType"));
      }

      const contents = await readHarFile(selected);
      const details = parseHarArchive(contents);
      handleImportSessions(details);
    } catch (error) {
      setImportSnackbarMessage(error instanceof Error ? error.message : t("common.errors.unexpected"));
    }
  }, [handleImportSessions, t]);

  const handleClearOthers = useCallback((session: SessionSummary) => {
    setContainerState((currentState) => clearOtherSessionsInActiveContainer(currentState, session.id));
  }, []);

  const handleGoToBreakpoints = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleGoToRules = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleCreateRewrite = useCallback((session: SessionSummary) => {
    navigate("/rules", {
      state: {
        rewriteSeed: {
          host: session.host,
          method: session.method,
          path: session.path,
          url: session.url,
        },
      },
    });
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
    setSessionSelectionNonce((currentValue) => currentValue + 1);
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        selectedSessionId: sessionId,
      })),
    );
    writeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY, sessionId);
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

  const handleInspectorSplitRatioChange = useCallback((ratio: number) => {
    setContainerState((currentState) =>
      updateActiveSessionContainer(currentState, (container) => ({
        ...container,
        inspectorSplitRatio: ratio,
      })),
    );
  }, []);

  const handleClearActiveContainer = useCallback(() => {
    clearSessions(undefined, {
      onSuccess: () => {
        removeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
        setContainerState((currentState) =>
          createInitialSessionContainerState({
            inspectorSplitRatio:
              getSessionContainerById(currentState, currentState.activeContainerId)?.inspectorSplitRatio
              ?? defaultInspectorSplitRatio,
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
  }, [clearSessions, defaultInspectorSplitRatio]);

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
          onClick={() => handleOpenExportDialog()}
          disabled={activeSessions.length === 0}
          icon={<DownloadRoundedIcon />}
          label={t("sessionsPage.export")}
        />
      </Stack>
    ),
    [activeSessions.length, handleClearActiveContainer, handleOpenExportDialog, isClearingSessions, t],
  );

  useLayoutEffect(() => {
    setHeaderActions(headerActions);

    return () => {
      setHeaderActions(null);
    };
  }, [headerActions, setHeaderActions]);

  function startExplorerResize(event: ReactPointerEvent<HTMLDivElement>) {
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

      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }

      explorerDragFrameRef.current = window.requestAnimationFrame(() => {
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

  const startInspectorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;

    if (!container || activeContainer?.requestCollapsed) {
      return;
    }

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateRatio = (clientY: number) => {
      const bounds = container.getBoundingClientRect();

      if (bounds.height <= 0) {
        return;
      }

      const nextRatio = clampInspectorSplitRatio((clientY - bounds.top) / bounds.height);

      if (inspectorDragFrameRef.current) {
        window.cancelAnimationFrame(inspectorDragFrameRef.current);
      }

      inspectorDragFrameRef.current = window.requestAnimationFrame(() => {
        handleInspectorSplitRatioChange(nextRatio);
      });
    };

    updateRatio(event.clientY);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientY);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [activeContainer?.requestCollapsed, handleInspectorSplitRatioChange]);

  useEffect(() => {
    const menuAction = readSessionsMenuAction(location.state);

    if (!menuAction || menuAction.requestedAt <= lastHandledMenuActionRef.current) {
      return;
    }

    lastHandledMenuActionRef.current = menuAction.requestedAt;

    if (menuAction.kind === "import-har") {
      handleImportHarPickerOpen();
      return;
    }

    handleOpenExportDialog();
  }, [handleImportHarPickerOpen, handleOpenExportDialog, location.key, location.state]);

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
        inspectorSplitRatio={activeContainer?.inspectorSplitRatio ?? defaultInspectorSplitRatio}
        isDetailLoading={isSessionDetailLoading}
        isLoading={isLoading || areSessionsLoading}
        onAddContainer={handleAddContainer}
        onCloseContainer={handleCloseContainer}
        onContextMenuHost={handleHostContextMenu}
        onContextMenuSession={handleContextMenu}
        onCopyCurl={selectedSession ? () => { void handleCopyCurl(selectedSession); } : undefined}
        onCopyUrl={selectedSession ? () => { handleCopyUrl(selectedSession); } : undefined}
        onDomainFilterChange={handleDomainFilterChange}
        onInspectorResizeStart={startInspectorResize}
        onRepeat={selectedSession ? handleRepeat : undefined}
        onRequestCollapsedChange={handleRequestCollapsedChange}
        onRequestTabChange={handleRequestTabChange}
        onResizeStart={startExplorerResize}
        onResponseTabChange={handleResponseTabChange}
        onSelectContainer={handleSelectContainer}
        onSelectSession={handleSelectedSessionChange}
        onToggleHost={toggleHost}
        requestCollapsed={activeContainer?.requestCollapsed ?? false}
        requestTab={activeContainer?.requestTab ?? "headers"}
        responseTab={activeContainer?.responseTab ?? "overview"}
        sessionSelectionNonce={sessionSelectionNonce}
        runtimeErrorMessage={error ? t("sessionsPage.runtimeError") : undefined}
        selectedSession={selectedSession}
        selectedSessionDetail={selectedSessionDetail}
        selectedSessionId={selectedSessionIdValue}
        workspaceRef={workspaceRef}
      />

      <SessionExportDialog
        allSessions={activeSessions}
        filteredSessions={visibleSessions}
        {...(exportDialogHostScope ? { hostScope: exportDialogHostScope } : {})}
        {...(exportDialogInitialScope ? { initialScope: exportDialogInitialScope } : {})}
        onClose={() => {
          setExportDialogOpen(false);
          setExportDialogInitialScope(undefined);
          setExportDialogHostScope(null);
        }}
        open={exportDialogOpen}
        selectedSession={selectedSession}
        selectedSessionDetail={selectedSessionDetail}
      />

      <SessionContextMenu
        anchorPosition={contextMenuAnchor}
        isHostFocused={contextMenuSession ? focusedHosts.has(contextMenuSession.host) : false}
        isHostIgnored={contextMenuSession ? ignoredHosts.has(contextMenuSession.host) : false}
        onClose={handleContextMenuClose}
        onClearOthers={handleClearOthers}
        onCompose={handleCompose}
        onCopyCurl={handleCopyCurl}
        onCopyRequest={handleCopyRequest}
        onCopyResponse={handleCopyResponse}
        onCopyUrl={handleCopyUrl}
        onCreateRewrite={handleCreateRewrite}
        onExportSession={handleExportSession}
        onFocusHost={handleFocusHost}
        onGoToBreakpoints={handleGoToBreakpoints}
        onGoToRules={handleGoToRules}
        onIgnoreHost={handleIgnoreHost}
        onRepeat={handleRepeatSession}
        onSaveResponse={handleSaveResponse}
        onSaveToCollection={handleSaveToCollection}
        onStopIgnoringHost={handleStopIgnoringHost}
        onUnfocusHost={handleUnfocusHost}
        session={contextMenuSession}
      />

      <SaveToCollectionDialog
        open={saveToCollectionSession !== null}
        sessionName={saveToCollectionSession ? `${saveToCollectionSession.method} ${saveToCollectionSession.host}${saveToCollectionSession.path}` : ""}
        onCancel={handleSaveToCollectionCancel}
        onConfirm={handleSaveToCollectionConfirm}
      />

      <DomainContextMenu
        anchorPosition={domainContextMenuAnchor}
        host={contextMenuHost}
        isHostFocused={contextMenuHost ? focusedHosts.has(contextMenuHost) : false}
        isHostIgnored={contextMenuHost ? ignoredHosts.has(contextMenuHost) : false}
        onClose={handleHostContextMenuClose}
        onExportHost={handleExportHost}
        onFocusHost={handleFocusDomain}
        onIgnoreHost={handleIgnoreDomain}
        onStopIgnoringHost={handleStopIgnoringDomain}
        onUnfocusHost={handleUnfocusDomain}
      />

      <Snackbar
        anchorOrigin={{ horizontal: "center", vertical: "bottom" }}
        autoHideDuration={2000}
        onClose={handleSnackbarClose}
        open={snackbarMessage !== null}
        message={snackbarMessage}
      />

      <Snackbar
        anchorOrigin={{ horizontal: "center", vertical: "bottom" }}
        autoHideDuration={2400}
        onClose={() => setImportSnackbarMessage(null)}
        open={importSnackbarMessage !== null}
        message={importSnackbarMessage}
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

function readFocusedHostsFromStorage(): Set<string> {
  return new Set(readStoredHosts(FOCUSED_HOSTS_STORAGE_KEY));
}

async function exportSessionsAsHar(
  queryClient: QueryClient,
  sessions: SessionSummary[],
  filename: string,
) {
  if (sessions.length === 0) {
    return;
  }

  const details = await Promise.all(
    sessions.map((session) => ensureSessionDetailContent(queryClient, session.id, {
      includeRawRequest: true,
      includeRawResponse: true,
      includeRequestBodyText: true,
      includeResponseBodyText: true,
      includeRequestBodyBase64: true,
      includeResponseBodyBase64: true,
    })),
  );

  await downloadTextFile(
    filename,
    JSON.stringify(buildHarArchive(details), null, 2),
    "application/json",
    { revealInFolder: true },
  );
}
