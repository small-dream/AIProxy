import {
  coerceAppError,
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  isAppError,
} from "@pharles/shared-types";
import { Alert, Box, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";

import {
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import {
  CaptureControlStrip,
  type SystemProxyActionState,
} from "@/features/sessions/components/CaptureControlStrip";
import { SessionExplorerPane } from "@/features/sessions/components/SessionExplorerPane";
import {
  type InspectorPrimaryTab,
  type InspectorSecondaryTab,
  SessionInspectorWorkspace,
} from "@/features/sessions/components/SessionInspectorWorkspace";
import {
  buildSessionHostGroups,
  reconcileExpandedHosts,
  type SessionExplorerScope,
} from "@/features/sessions/session-explorer.helpers";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessions } from "@/features/sessions/use-sessions";
import { logDevInfo, logDevWarn } from "@/services/logger/dev-logger";

export function SessionsPage() {
  const { data: proxyStatus, error, isLoading } = useProxyStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const {
    data: sessions = [],
    error: sessionsError,
    isLoading: areSessionsLoading,
  } = useSessions(proxyStatus?.running ?? false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [searchValue, setSearchValue] = useState("");
  const [scope, setScope] = useState<SessionExplorerScope>("all");
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);
  const [primaryInspectorTab, setPrimaryInspectorTab] = useState<InspectorPrimaryTab>("overview");
  const [secondaryInspectorTab, setSecondaryInspectorTab] = useState<InspectorSecondaryTab>("headers");
  const [systemProxyActionState, setSystemProxyActionState] = useState<SystemProxyActionState>("idle");
  const [systemProxyActionMessage, setSystemProxyActionMessage] = useState(
    "System proxy has not been requested in this session yet.",
  );

  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const isBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending ||
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending;
  const hostGroups = useMemo(() => buildSessionHostGroups(sessions, searchValue, scope), [scope, searchValue, sessions]);
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
    "Unable to load captured sessions from the proxy runtime.",
  );
  const mutationError = startProxyMutation.error ??
    stopProxyMutation.error ??
    enableSystemProxyMutation.error ??
    disableSystemProxyMutation.error;
  const mutationErrorMessage = getOperationErrorMessage(
    mutationError,
    "The requested proxy operation failed before the UI could update its runtime state.",
  );

  useEffect(() => {
    setExpandedHosts((currentHosts) => reconcileExpandedHosts(currentHosts, hostGroups));
  }, [hostGroups]);

  function toggleHost(host: string) {
    setExpandedHosts((currentHosts) =>
      currentHosts.includes(host) ? currentHosts.filter((currentHost) => currentHost !== host) : [...currentHosts, host],
    );
  }

  function handleEnableSystemProxy() {
    logDevInfo("ui.sessions", "enable_system_proxy_click", {
      port,
      proxyRunning: proxyStatus?.running ?? false,
      workspaceId,
    });

    setSystemProxyActionState("requesting");
    setSystemProxyActionMessage("Requesting Windows system proxy takeover...");

    enableSystemProxyMutation.mutate(undefined, {
      onError: (mutationError) => {
        const message = getOperationErrorMessage(
          mutationError,
          "Enable System Proxy failed before runtime state changed.",
        );

        logDevWarn("ui.sessions", "enable_system_proxy_click_failed", {
          message,
          workspaceId,
        });
        setSystemProxyActionState("failed");
        setSystemProxyActionMessage(message);
      },
      onSuccess: (status) => {
        const message = status.systemProxyEnabled
          ? `Windows system proxy now points to 127.0.0.1:${status.port}.`
          : "System proxy action completed, but enabled state stayed off.";

        logDevInfo("ui.sessions", "enable_system_proxy_click_succeeded", {
          port: status.port,
          systemProxyEnabled: status.systemProxyEnabled,
          workspaceId: status.activeWorkspaceId,
        });
        setSystemProxyActionState(status.systemProxyEnabled ? "succeeded" : "failed");
        setSystemProxyActionMessage(message);
      },
    });
  }

  function handleDisableSystemProxy() {
    logDevInfo("ui.sessions", "disable_system_proxy_click", {
      workspaceId,
    });

    setSystemProxyActionState("requesting");
    setSystemProxyActionMessage("Restoring previous Windows system proxy settings...");

    disableSystemProxyMutation.mutate(undefined, {
      onError: (mutationError) => {
        const message = getOperationErrorMessage(
          mutationError,
          "Disable System Proxy failed before runtime state changed.",
        );

        logDevWarn("ui.sessions", "disable_system_proxy_click_failed", {
          message,
          workspaceId,
        });
        setSystemProxyActionState("failed");
        setSystemProxyActionMessage(message);
      },
      onSuccess: (status) => {
        logDevInfo("ui.sessions", "disable_system_proxy_click_succeeded", {
          port: status.port,
          systemProxyEnabled: status.systemProxyEnabled,
          workspaceId: status.activeWorkspaceId,
        });
        setSystemProxyActionState("succeeded");
        setSystemProxyActionMessage("Previous Windows system proxy settings restored.");
      },
    });
  }

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h5">Sessions</Typography>
        <Typography color="text.secondary" variant="body2">
          Charles-style traffic workbench with a host-grouped explorer and a detail-focused inspector.
        </Typography>
      </Stack>

      <CaptureControlStrip
        busy={isBusy}
        isRunning={proxyStatus?.running ?? false}
        onDisableSystemProxy={handleDisableSystemProxy}
        onEnableSystemProxy={handleEnableSystemProxy}
        onSearchChange={setSearchValue}
        onStart={() =>
          startProxyMutation.mutate({
            enableSsl: false,
            port,
            workspaceId,
          })
        }
        onStop={() => stopProxyMutation.mutate(workspaceId)}
        port={port}
        searchValue={searchValue}
        sessionCount={sessions.length}
        sslEnabled={proxyStatus?.sslEnabled ?? false}
        systemProxyActionMessage={systemProxyActionMessage}
        systemProxyActionState={systemProxyActionState}
        systemProxyEnabled={proxyStatus?.systemProxyEnabled ?? false}
        workspaceId={workspaceId}
      />

      {error ? (
        <Alert severity="error">
          Unable to load proxy runtime state. Capture controls may be stale until the Tauri command layer responds again.
        </Alert>
      ) : null}

      {mutationError ? (
        <Alert severity="error">
          {mutationErrorMessage}
        </Alert>
      ) : null}

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: {
            lg: "minmax(320px, 380px) minmax(0, 1fr)",
            xs: "1fr",
          },
          minHeight: {
            lg: "calc(100vh - 260px)",
            xs: 640,
          },
        }}
      >
        <SessionExplorerPane
          errorMessage={sessionsError ? sessionsErrorMessage : undefined}
          expandedHosts={expandedHosts}
          groups={hostGroups}
          isLoading={isLoading || areSessionsLoading}
          onScopeChange={setScope}
          onSelectSession={setSelectedSessionId}
          onToggleHost={toggleHost}
          scope={scope}
          selectedSessionId={selectedSessionIdValue}
        />

        <SessionInspectorWorkspace
          detailErrorMessage={
            sessionDetailError
              ? getOperationErrorMessage(
                  sessionDetailError,
                  "Unable to load the selected session detail from the desktop runtime.",
                )
              : undefined
          }
          isDetailLoading={isSessionDetailLoading}
          onPrimaryTabChange={setPrimaryInspectorTab}
          onSecondaryTabChange={setSecondaryInspectorTab}
          primaryTab={primaryInspectorTab}
          secondaryTab={secondaryInspectorTab}
          selectedSessionDetail={selectedSessionDetail}
          selectedSession={selectedSession}
        />
      </Box>
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
