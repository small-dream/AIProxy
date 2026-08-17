import { coerceAppError, isAppError, DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
import type { SessionSummary } from "@aiproxy/shared-types";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import { Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { SetupChecklistCard } from "@/components/shared/SetupChecklistCard";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { useClearSessions } from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { DomainContextMenu } from "@/features/sessions/components/DomainContextMenu";
import { SessionContextMenu } from "@/features/sessions/components/SessionContextMenu";
import { SaveToCollectionDialog } from "@/features/collections/components/SaveToCollectionDialog";
import { SessionExportDialog } from "@/features/sessions/components/SessionExportDialog";
import type { WorkspaceHandle } from "@/features/sessions/components/SessionInspectorWorkspace";
import { SessionsWorkspacePanel } from "@/features/sessions/components/SessionsWorkspacePanel";
import { useSessionImportExport } from "@/features/sessions/use-session-import-export";
import { useSessionRepeat } from "@/features/sessions/use-session-repeat";
import {
  readSessionsHostFilterAction,
  readSessionsMenuAction,
} from "@/features/sessions/session-menu-actions";
import {
  readStorageValue,
  readStoredHosts,
  removeStorageValue,
  writeStorageValue,
} from "@/features/sessions/session-ui.helpers";
import { syncSessionCompareScopes } from "@/features/sessions/session-scope-registry";
import { useSessionContextActions } from "@/features/sessions/use-session-context-actions";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";
import { SESSION_DETAIL_QUERY_KEY, useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessionFilters } from "@/features/sessions/use-session-filters";
import { useSessionSelection } from "@/features/sessions/use-session-selection";
import { usePendingSessionTimeout } from "@/features/sessions/use-pending-session-timeout";
import {
  useSessionExplorerLayout,
  EXPANDED_HOSTS_STORAGE_KEY,
  INSPECTOR_SPLIT_RATIO_STORAGE_KEY,
  REQUEST_COLLAPSED_STORAGE_KEY,
  SELECTED_SESSION_ID_STORAGE_KEY,
  FOCUSED_HOSTS_STORAGE_KEY,
} from "@/features/sessions/use-session-explorer-layout";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";
import {
  isCapturedSessionNotFoundError,
  setFocusedHosts as syncFocusedHosts,
} from "@/services/commands";
import { logDevWarn } from "@/services/logger/dev-logger";
import {
  collectVisibleSessionIds,
  reconcileExpandedKeys,
} from "@/features/sessions/session-explorer.helpers";

const IGNORED_HOSTS_STORAGE_KEY = "aiproxy.sessions.ignoredHosts";
const COMPARE_BASE_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.compareBaseSessionId";

export function SessionsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();
  const loadFromSession = useComposeEditorStore((s) => s.loadFromSession);
  const { mutate: clearSessions, isPending: isClearingSessions } = useClearSessions();
  // Destructive: clearing the active container requires confirmation unless the
  // user opted out via the dialog checkbox (re-enablable in Settings).
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearDontAskAgain, setClearDontAskAgain] = useState(false);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
  const skipClearSessionsConfirm = useAppPreferencesStore((s) => s.skipClearSessionsConfirm);
  const setSkipClearSessionsConfirm = useAppPreferencesStore((s) => s.setSkipClearSessionsConfirm);
  const { data: proxyStatus, error, isLoading } = useProxyStatus();
  const { data: workspaces = [] } = useWorkspaces();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const startProxyMutation = useStartProxy();
  const {
    data: runtimeSessions = [],
    error: sessionsError,
    isLoading: areSessionsLoading,
  } = useSessions();

  const lastHandledHostFilterActionRef = useRef(0);
  const lastHandledSessionSelectRef = useRef(0);

  const store = useSessionContainerStore;
  const {
    activeContainerId,
    containers,
    hydrated,
    sessionSummaryById,
    seedSessions,
    addContainer,
    closeContainer,
    selectContainer,
    updateActiveContainer: updateContainer,
    clearOtherSessions,
    removeSummary: removeSummaryFromStore,
    clearSessions: clearStoreSessions,
  } = store();

  const lastHandledMenuActionRef = useRef(0);

  // Workspace ref for Cmd+F
  const workspaceRef = useRef<WorkspaceHandle>(null);

  const activeContainer = containers.find((c) => c.id === activeContainerId) ?? containers[0];
  const currentWorkspace = useMemo(
    () =>
      workspaces.find(
        (workspace) => workspace.id === (proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID),
      ) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null,
    [proxyStatus?.activeWorkspaceId, workspaces],
  );

  // Active sessions from the container
  const activeSessions = useMemo(
    () =>
      (activeContainer?.sessionIds ?? [])
        .map((sessionId) => sessionSummaryById[sessionId])
        .filter((session): session is SessionSummary => Boolean(session)),
    [activeContainer?.sessionIds, sessionSummaryById],
  );

  // ═══ extracted hooks ════════════════════════════════════════════
  // Order matters: timeout hook produces displayActiveSessions which
  // the filter hook consumes for its ignore/throttle/domain pipelines.

  const { locallyTimedOutSessionIds, displayActiveSessions, markSessionLocallyTimedOut } =
    usePendingSessionTimeout({ activeSessions });

  const {
    focusedHosts,
    setFocusedHosts,
    ignoredHosts,
    setIgnoredHosts,
    showOnlyThrottled,
    setShowOnlyThrottled,
    compareBaseSessionId,
    setCompareBaseSessionId,
    hostGroups,
    visibleSessions,
    toggleHost,
  } = useSessionFilters({
    displayActiveSessions,
    updateContainer,
    searchValue: activeContainer?.searchValue ?? "",
  });

  // Visual tree order of the currently visible leaves — the single source of
  // truth for keyboard navigation and Shift+click range selection.
  const visibleSessionOrder = useMemo(
    () => collectVisibleSessionIds(hostGroups, activeContainer?.expandedHosts ?? []),
    [activeContainer?.expandedHosts, hostGroups],
  );

  const {
    selectedSession,
    selectedRawSession,
    isSelectedSessionLocallyTimedOut,
    sessionSelectionNonce,
    multiSelectedSessionIds,
    handleSelectedSessionChange,
    clearMultiSelection,
    bumpSelectionNonce,
  } = useSessionSelection({
    visibleSessions,
    visibleSessionOrder,
    activeSessions,
    selectedSessionId: activeContainer?.selectedSessionId,
    locallyTimedOutSessionIds,
    updateContainer,
  });

  const {
    explorerWidth,
    defaultInspectorSplitRatio,
    startExplorerResize,
    startInspectorResize,
    handleRequestCollapsedChange,
    handleSearchValueChange,
    handleRequestTabChange,
    handleResponseTabChange,
  } = useSessionExplorerLayout({
    updateContainer,
    requestCollapsed: activeContainer?.requestCollapsed ?? false,
  });

  const selectedSessionIdValue = selectedSession?.id;
  const {
    data: selectedSessionDetail,
    error: sessionDetailError,
    isLoading: isSessionDetailLoading,
  } = useSessionDetail(isSelectedSessionLocallyTimedOut ? undefined : selectedSessionIdValue);
  const isStaleSessionDetailError = isCapturedSessionNotFoundError(sessionDetailError);

  // ── existing imperative handlers ─────────────────────────────────

  useEffect(() => {
    if (store.getState().hydrated) return;
    const storedSessionId = readStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
    store.getState().init({
      expandedHosts: readStoredHosts(EXPANDED_HOSTS_STORAGE_KEY),
      inspectorSplitRatio: defaultInspectorSplitRatio,
      requestCollapsed: readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
      requestTab: "query",
      responseTab: "overview",
      ...(storedSessionId ? { selectedSessionId: storedSessionId } : {}),
    });
  }, [defaultInspectorSplitRatio, store]);

  useEffect(() => {
    if (
      !selectedSessionIdValue ||
      !selectedSession ||
      !selectedRawSession ||
      selectedRawSession.statusCode > 0 ||
      !isStaleSessionDetailError
    ) {
      return;
    }

    logDevWarn("ui.sessions", "selected_pending_session_detail_missing", {
      host: selectedSession.host,
      method: selectedSession.method,
      path: selectedSession.path,
      sessionId: selectedSession.id,
      startedAt: selectedSession.startedAt,
      statusCode: selectedSession.statusCode,
      url: selectedSession.url,
    });
    markSessionLocallyTimedOut(selectedSession.id);
    queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, selectedSessionIdValue] });
  }, [
    isStaleSessionDetailError,
    markSessionLocallyTimedOut,
    queryClient,
    selectedRawSession,
    selectedSession,
    selectedSessionIdValue,
  ]);

  const sessionsErrorMessage = getOperationErrorMessage(
    sessionsError,
    t("sessionsPage.sessionsLoadError"),
  );

  useEffect(() => {
    if (areSessionsLoading) return;
    if (!store.getState().hydrated) {
      seedSessions(runtimeSessions);
    }
  }, [areSessionsLoading, runtimeSessions, seedSessions, store]);

  // Persist focused / ignored hosts
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

  // Persist container state
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
    writeStorageValue(
      REQUEST_COLLAPSED_STORAGE_KEY,
      String(activeContainer?.requestCollapsed ?? false),
    );
  }, [activeContainer?.requestCollapsed]);

  useEffect(() => {
    syncSessionCompareScopes(
      containers.map((container) => ({
        id: container.id,
        label: t("sessionsPage.containers.sessionTitle", { index: container.labelNumber }),
        sessionIds: container.sessionIds,
        updatedAt: new Date().toISOString(),
      })),
    );
  }, [containers, t]);

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
    if (!hydrated || !activeContainer) return;

    const nextExpandedHosts = reconcileExpandedKeys(activeContainer.expandedHosts, hostGroups);
    if (areStringArraysEqual(nextExpandedHosts, activeContainer.expandedHosts)) return;

    updateContainer((container) => ({
      ...container,
      expandedHosts: nextExpandedHosts,
    }));
  }, [activeContainer, hostGroups, hydrated, updateContainer]);

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
    showSnackbar,
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

  // ═══ repeat & import/export hooks ═══════════════════════════════

  const { handleRepeatSession, handleRepeat } = useSessionRepeat({
    selectedSession,
    handleRepeatDirect,
    updateContainer,
    bumpSelectionNonce,
  });

  const {
    exportDialogOpen,
    exportDialogInitialScope,
    exportDialogHostScope,
    importSnackbarMessage,
    handleExportSession,
    handleExportSessions,
    handleExportHost,
    handleImportHarPickerOpen,
    handleOpenExportDialog,
    setExportDialogOpen,
    setExportDialogInitialScope,
    setExportDialogHostScope,
    setImportSnackbarMessage,
  } = useSessionImportExport({
    queryClient,
    visibleSessions,
    onImportComplete: (details) => {
      for (const d of details) {
        store.getState().upsertSummary(d.summary);
      }
      updateContainer((c) => ({
        ...c,
        ...(details[0]?.id ? { selectedSessionId: details[0].id } : {}),
      }));
      bumpSelectionNonce();
    },
  });

  const handleClearOthers = useCallback(
    (session: SessionSummary) => {
      clearOtherSessions(session.id);
    },
    [clearOtherSessions],
  );

  // Sessions visible in the current filtered tree that are part of the
  // multi-selection (Cmd/Ctrl+click). Shared by the batch action bar.
  const selectedMultiSessions = useMemo(
    () => visibleSessions.filter((session) => multiSelectedSessionIds.has(session.id)),
    [multiSelectedSessionIds, visibleSessions],
  );

  const handleExportSelected = useCallback(() => {
    if (selectedMultiSessions.length === 0) return;
    handleExportSessions(selectedMultiSessions);
  }, [handleExportSessions, selectedMultiSessions]);

  const handleSaveSelectedResponses = useCallback(async () => {
    if (selectedMultiSessions.length === 0) return;

    let savedCount = 0;
    for (const session of selectedMultiSessions) {
      try {
        if (await handleSaveResponse(session)) {
          savedCount += 1;
        }
      } catch {
        // A failed download (e.g. detail load error) is skipped; sessions
        // without a captured response body return false and are not counted.
      }
    }
    showSnackbar(t("sessionsPage.batchSaveResponsesDone", { count: savedCount }));
  }, [handleSaveResponse, selectedMultiSessions, showSnackbar, t]);

  const handleRequestDeleteSelected = useCallback(() => {
    if (selectedMultiSessions.length === 0) return;
    setBatchDeleteConfirmOpen(true);
  }, [selectedMultiSessions.length]);

  const handleConfirmDeleteSelected = useCallback(() => {
    const count = selectedMultiSessions.length;
    if (count === 0) {
      setBatchDeleteConfirmOpen(false);
      return;
    }

    for (const session of selectedMultiSessions) {
      removeSummaryFromStore(session.id);
    }
    clearMultiSelection();
    setBatchDeleteConfirmOpen(false);
    showSnackbar(t("sessionsPage.batchDeleteDone", { count }));
  }, [clearMultiSelection, removeSummaryFromStore, selectedMultiSessions, showSnackbar, t]);

  const handleGoToBreakpoints = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleGoToRules = useCallback(() => {
    navigate("/rules");
  }, [navigate]);

  const handleCreateRewrite = useCallback(
    (session: SessionSummary) => {
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
    },
    [navigate],
  );

  const handleCreateMapLocal = useCallback(
    (session: SessionSummary) => {
      navigate("/rules", {
        state: {
          mapLocalSeed: {
            host: session.host,
            method: session.method,
            path: session.path,
            url: session.url,
          },
        },
      });
    },
    [navigate],
  );

  const handleToggleSslDecrypt = useCallback(
    async (session: SessionSummary) => {
      if (!currentWorkspace || !session.host) return;

      const host = session.host;
      const currentList = currentWorkspace.sslBlindHosts ?? [];
      const isDisabling = !currentList.includes(host);
      const nextList = isDisabling
        ? [...currentList, host]
        : currentList.filter((candidate) => candidate !== host);

      try {
        await updateWorkspaceMutation.mutateAsync({
          workspaceId: currentWorkspace.id,
          sslBlindHosts: nextList,
        });

        // Applying the new per-host setting requires a proxy restart so fresh
        // CONNECT tunnels pick up the updated blind list (same pattern as the
        // global SSL toggle on the settings page).
        if (proxyStatus?.running) {
          await startProxyMutation.mutateAsync({
            enableHttp2: proxyStatus.http2Enabled ?? true,
            enableSsl: proxyStatus.sslEnabled,
            port: proxyStatus.port,
            workspaceId: currentWorkspace.id,
          });
        }

        showSnackbar(
          t(isDisabling ? "sessionsPage.sslDecryptDisabled" : "sessionsPage.sslDecryptEnabled", {
            host,
          }),
        );
      } catch {
        showSnackbar(t("sessionsPage.sslDecryptToggleFailed"));
      }
    },
    [currentWorkspace, proxyStatus, showSnackbar, startProxyMutation, t, updateWorkspaceMutation],
  );

  const handleCreateThrottleRule = useCallback(
    (session: SessionSummary) => {
      navigate("/throttling", {
        state: {
          throttleSeed: {
            host: session.host,
            method: session.method,
            path: session.path,
            url: session.url,
          },
        },
      });
    },
    [navigate],
  );

  const handleSetCompareBase = useCallback(
    (session: SessionSummary) => {
      setCompareBaseSessionId(session.id);
      writeStorageValue(COMPARE_BASE_SESSION_ID_STORAGE_KEY, session.id);
      setImportSnackbarMessage(
        t("sessionsPage.compareBaseSet", {
          method: session.method,
          path: session.path,
        }),
      );
    },
    [setCompareBaseSessionId, setImportSnackbarMessage, t],
  );

  const handleCompareWith = useCallback(
    (session: SessionSummary) => {
      const left =
        compareBaseSessionId && compareBaseSessionId !== session.id
          ? compareBaseSessionId
          : selectedSession?.id && selectedSession.id !== session.id
            ? selectedSession.id
            : "";

      if (!left) {
        handleSetCompareBase(session);
        return;
      }

      navigate(`/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(session.id)}`);
    },
    [compareBaseSessionId, handleSetCompareBase, navigate, selectedSession],
  );

  const handleAddContainer = useCallback(() => {
    addContainer();
  }, [addContainer]);

  const handleSelectContainer = useCallback(
    (containerId: string) => {
      selectContainer(containerId);
    },
    [selectContainer],
  );

  const handleCloseContainer = useCallback(
    (containerId: string) => {
      closeContainer(containerId);
    },
    [closeContainer],
  );

  // ── note: handleSelectedSessionChange / handleRequestTabChange /
  //          handleResponseTabChange / handleRequestCollapsedChange /
  //          handleDomainFilterChange / handleInspectorSplitRatioChange
  //          are now provided by useSessionSelection / useSessionExplorerLayout

  const handleClearActiveContainer = useCallback(() => {
    clearSessions(undefined, {
      onSuccess: () => {
        removeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
        clearStoreSessions({
          inspectorSplitRatio: activeContainer?.inspectorSplitRatio ?? defaultInspectorSplitRatio,
          requestCollapsed:
            activeContainer?.requestCollapsed ??
            readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
          requestTab: activeContainer?.requestTab ?? "headers",
          responseTab: activeContainer?.responseTab ?? "overview",
        });
        showSnackbar(t("sessionsPage.clearSessionsDone"));
      },
    });
  }, [
    clearSessions,
    clearStoreSessions,
    defaultInspectorSplitRatio,
    activeContainer,
    showSnackbar,
    t,
  ]);

  // Honor the persisted "don't ask again" opt-out from the clear dialog.
  const requestClearActiveContainer = useCallback(() => {
    if (skipClearSessionsConfirm) {
      handleClearActiveContainer();
      return;
    }
    setClearDontAskAgain(false);
    setClearConfirmOpen(true);
  }, [skipClearSessionsConfirm, handleClearActiveContainer]);

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
          onClick={() => setShowOnlyThrottled((value) => !value)}
          disabled={activeSessions.length === 0}
          icon={<SpeedRoundedIcon />}
          label={
            showOnlyThrottled
              ? t("sessionsPage.filterAllSessions")
              : t("sessionsPage.filterThrottled")
          }
        />
        <TopBarActionButton
          onClick={requestClearActiveContainer}
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
    [
      activeSessions.length,
      handleOpenExportDialog,
      isClearingSessions,
      requestClearActiveContainer,
      setShowOnlyThrottled,
      showOnlyThrottled,
      t,
    ],
  );

  useLayoutEffect(() => {
    setHeaderActions(headerActions);

    return () => {
      setHeaderActions(null);
    };
  }, [headerActions, setHeaderActions]);

  // ── resize handlers and effect wrappers are provided by useSessionExplorerLayout

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

  useEffect(() => {
    const hostFilterAction = readSessionsHostFilterAction(location.state);

    if (
      !hostFilterAction ||
      hostFilterAction.requestedAt <= lastHandledHostFilterActionRef.current
    ) {
      return;
    }

    lastHandledHostFilterActionRef.current = hostFilterAction.requestedAt;

    updateContainer((container) => ({
      ...container,
      searchValue: hostFilterAction.host,
      expandedHosts: container.expandedHosts.includes(hostFilterAction.host)
        ? container.expandedHosts
        : [...container.expandedHosts, hostFilterAction.host],
    }));
  }, [location.key, location.state, updateContainer]);

  useEffect(() => {
    const action = location.state?.sessionSelect;
    if (!action || typeof action !== "object") return;
    if (action.requestedAt <= lastHandledSessionSelectRef.current) return;
    lastHandledSessionSelectRef.current = action.requestedAt;

    const sessionId = action.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;

    const current = useSessionContainerStore.getState();
    const container = current.containers.find((c) => c.id === current.activeContainerId);
    if (container?.sessionIds.includes(sessionId)) {
      const summary = current.sessionSummaryById[sessionId];
      const host = summary?.host;
      const pathKeys: string[] = [];
      if (host) {
        pathKeys.push(host);
        if (summary.path) {
          const segments = summary.path.replace(/^\//, "").split("/").filter(Boolean);
          for (let i = 1; i < segments.length; i++) {
            pathKeys.push(`${host}::${segments.slice(0, i).join("/")}`);
          }
        }
      }
      updateContainer((c) => {
        const existing = new Set(c.expandedHosts);
        const merged = [...c.expandedHosts];
        for (const key of pathKeys) {
          if (!existing.has(key)) {
            merged.push(key);
          }
        }
        return { ...c, selectedSessionId: sessionId, expandedHosts: merged };
      });
      writeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY, sessionId);
    }
  }, [location.key, location.state, updateContainer]);

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <SetupChecklistCard />
      <SessionsWorkspacePanel
        activeContainerId={activeContainerId}
        containerTabs={containers.map((container) => ({
          id: container.id,
          labelNumber: container.labelNumber,
        }))}
        detailErrorMessage={
          sessionDetailError && !(isStaleSessionDetailError && selectedRawSession?.statusCode === 0)
            ? getOperationErrorMessage(sessionDetailError, t("sessionsPage.detailLoadError"))
            : undefined
        }
        errorMessage={sessionsError ? sessionsErrorMessage : undefined}
        expandedHosts={activeContainer?.expandedHosts ?? []}
        explorerWidth={explorerWidth}
        focusedHosts={focusedHosts}
        groups={hostGroups}
        ignoredHosts={ignoredHosts}
        inspectorSplitRatio={activeContainer?.inspectorSplitRatio ?? defaultInspectorSplitRatio}
        isDetailLoading={isSessionDetailLoading}
        isLoading={isLoading || areSessionsLoading}
        multiSelectedSessionIds={multiSelectedSessionIds}
        onAddContainer={handleAddContainer}
        onCloseContainer={handleCloseContainer}
        onClearMultiSelection={clearMultiSelection}
        onContextMenuHost={handleHostContextMenu}
        onContextMenuSession={handleContextMenu}
        onCopyCurl={
          selectedSession
            ? () => {
                void handleCopyCurl(selectedSession);
              }
            : undefined
        }
        onCopyUrl={
          selectedSession
            ? () => {
                handleCopyUrl(selectedSession);
              }
            : undefined
        }
        onDeleteSelected={handleRequestDeleteSelected}
        onDisableThrottledOnly={() => setShowOnlyThrottled(false)}
        onExportSelected={handleExportSelected}
        onInspectorResizeStart={startInspectorResize}
        onRepeat={selectedSession ? handleRepeat : undefined}
        onRequestCollapsedChange={handleRequestCollapsedChange}
        onRequestTabChange={handleRequestTabChange}
        onResizeStart={startExplorerResize}
        onResponseTabChange={handleResponseTabChange}
        onSaveSelectedResponses={handleSaveSelectedResponses}
        onSearchValueChange={handleSearchValueChange}
        onSelectContainer={handleSelectContainer}
        onSelectSession={handleSelectedSessionChange}
        onStopIgnoringHost={handleStopIgnoringDomain}
        onToggleHost={toggleHost}
        onUnfocusHost={handleUnfocusDomain}
        requestCollapsed={activeContainer?.requestCollapsed ?? false}
        requestTab={activeContainer?.requestTab ?? "headers"}
        responseTab={activeContainer?.responseTab ?? "overview"}
        searchValue={activeContainer?.searchValue ?? ""}
        sessionSelectionNonce={sessionSelectionNonce}
        runtimeErrorMessage={error ? t("sessionsPage.runtimeError") : undefined}
        selectedSession={selectedSession}
        selectedSessionDetail={selectedSessionDetail}
        selectedSessionId={selectedSessionIdValue}
        showOnlyThrottled={showOnlyThrottled}
        visibleSessionOrder={visibleSessionOrder}
        workspaceRef={workspaceRef}
      />

      <SessionExportDialog
        allSessions={displayActiveSessions}
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
        isHostSslDecryptDisabled={
          contextMenuSession
            ? (currentWorkspace?.sslBlindHosts ?? []).includes(contextMenuSession.host)
            : false
        }
        onClose={handleContextMenuClose}
        onClearOthers={handleClearOthers}
        onCompose={handleCompose}
        onCompareWith={handleCompareWith}
        onCopyCurl={handleCopyCurl}
        onCopyRequest={handleCopyRequest}
        onCopyResponse={handleCopyResponse}
        onCopyUrl={handleCopyUrl}
        onCreateMapLocal={handleCreateMapLocal}
        onCreateRewrite={handleCreateRewrite}
        onCreateThrottleRule={handleCreateThrottleRule}
        onExportSession={handleExportSession}
        onFocusHost={handleFocusHost}
        onGoToBreakpoints={handleGoToBreakpoints}
        onGoToRules={handleGoToRules}
        onIgnoreHost={handleIgnoreHost}
        onRepeat={handleRepeatSession}
        onSaveResponse={handleSaveResponse}
        onSaveToCollection={handleSaveToCollection}
        onSetCompareBase={handleSetCompareBase}
        onStopIgnoringHost={handleStopIgnoringHost}
        onToggleSslDecrypt={handleToggleSslDecrypt}
        onUnfocusHost={handleUnfocusHost}
        session={contextMenuSession}
      />

      <SaveToCollectionDialog
        open={saveToCollectionSession !== null}
        sessionName={
          saveToCollectionSession
            ? `${saveToCollectionSession.method} ${saveToCollectionSession.host}${saveToCollectionSession.path}`
            : ""
        }
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

      <ConfirmDialog
        open={clearConfirmOpen}
        title={t("sessionsPage.clearSessionsTitle")}
        message={t("sessionsPage.clearSessionsConfirm")}
        confirmLabel={t("common.actions.clearSessions")}
        dontAskAgainLabel={t("sessionsPage.clearSessionsDontAskAgain")}
        dontAskAgainChecked={clearDontAskAgain}
        onDontAskAgainChange={setClearDontAskAgain}
        onConfirm={() => {
          if (clearDontAskAgain) {
            setSkipClearSessionsConfirm(true);
          }
          setClearConfirmOpen(false);
          handleClearActiveContainer();
        }}
        onCancel={() => setClearConfirmOpen(false)}
        isConfirming={isClearingSessions}
      />

      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        title={t("sessionsPage.batchDeleteTitle")}
        message={t("sessionsPage.batchDeleteConfirm", { count: selectedMultiSessions.length })}
        confirmLabel={t("sessionsPage.batchDelete")}
        onConfirm={handleConfirmDeleteSelected}
        onCancel={() => setBatchDeleteConfirmOpen(false)}
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
