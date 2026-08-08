import { coerceAppError, isAppError } from "@aiproxy/shared-types";
import type { SessionSummary } from "@aiproxy/shared-types";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import { Snackbar, Stack } from "@mui/material";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { SetupChecklistCard } from "@/components/shared/SetupChecklistCard";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useClearSessions } from "@/features/proxy-status/use-proxy-status";
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
import { reconcileExpandedKeys } from "@/features/sessions/session-explorer.helpers";

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
  const { error, isLoading } = useProxyStatus();
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
    clearSessions: clearStoreSessions,
  } = store();

  const lastHandledMenuActionRef = useRef(0);

  // Workspace ref for Cmd+F
  const workspaceRef = useRef<WorkspaceHandle>(null);

  const activeContainer = containers.find((c) => c.id === activeContainerId) ?? containers[0];

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
    domainFilterValue: activeContainer?.domainFilterValue ?? "",
    searchValue: activeContainer?.searchValue ?? "",
  });

  const {
    selectedSession,
    selectedRawSession,
    isSelectedSessionLocallyTimedOut,
    sessionSelectionNonce,
    handleSelectedSessionChange,
    bumpSelectionNonce,
  } = useSessionSelection({
    visibleSessions,
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
    handleDomainFilterChange,
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
      },
    });
  }, [clearSessions, clearStoreSessions, defaultInspectorSplitRatio, activeContainer]);

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
    [
      activeSessions.length,
      handleClearActiveContainer,
      handleOpenExportDialog,
      isClearingSessions,
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
      domainFilterValue: hostFilterAction.host,
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
        onClose={handleContextMenuClose}
        onClearOthers={handleClearOthers}
        onCompose={handleCompose}
        onCompareWith={handleCompareWith}
        onCopyCurl={handleCopyCurl}
        onCopyRequest={handleCopyRequest}
        onCopyResponse={handleCopyResponse}
        onCopyUrl={handleCopyUrl}
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
