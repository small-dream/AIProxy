import {
  coerceAppError,
  isAppError,
} from "@pharles/shared-types";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, OutlinedInput, Stack, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

import { useClearSessions, useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { SessionExplorerPane } from "@/features/sessions/components/SessionExplorerPane";
import { SessionInspectorWorkspace } from "@/features/sessions/components/SessionInspectorWorkspace";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import {
  buildSessionHostGroups,
  reconcileExpandedHosts,
  type SessionExplorerScope,
} from "@/features/sessions/session-explorer.helpers";
import { useSessionDetail } from "@/features/sessions/use-session-detail";
import { useSessions } from "@/features/sessions/use-sessions";

export function SessionsPage() {
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
  const [scope, setScope] = useState<SessionExplorerScope>("all");
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);
  const [requestInspectorTab, setRequestInspectorTab] = useState<RequestInspectorTab>("overview");
  const [responseInspectorTab, setResponseInspectorTab] = useState<ResponseInspectorTab>("overview");
  const [requestCollapsed, setRequestCollapsed] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(360);

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

  useEffect(() => {
    setExpandedHosts((currentHosts) => reconcileExpandedHosts(currentHosts, hostGroups));
  }, [hostGroups]);

  useEffect(() => {
    const savedWidth = window.localStorage.getItem("pharles.sessions.explorerWidth");
    const parsedWidth = Number(savedWidth);
    const savedRequestCollapsed =
      window.localStorage.getItem("pharles.sessions.requestCollapsed") === "true";

    if (Number.isFinite(parsedWidth)) {
      setExplorerWidth(clampExplorerWidth(parsedWidth));
    }

    setRequestCollapsed(savedRequestCollapsed);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("pharles.sessions.explorerWidth", String(explorerWidth));
  }, [explorerWidth]);

  useEffect(() => {
    window.localStorage.setItem(
      "pharles.sessions.requestCollapsed",
      String(requestCollapsed),
    );
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
    <Stack spacing={1.5} sx={{ height: "100%", minHeight: 0 }}>
      <Stack
        alignItems={{ lg: "center", xs: "stretch" }}
        direction={{ lg: "row", xs: "column" }}
        justifyContent="space-between"
        spacing={1.25}
      >
        <OutlinedInput
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder="Filter hosts, paths, methods, or status"
          size="small"
          startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
          sx={{ minWidth: { lg: 360, xs: "100%" } }}
          value={searchValue}
        />

        <ToggleButtonGroup
          exclusive
          onChange={(_event, nextScope: SessionExplorerScope | null) => {
            if (nextScope) {
              setScope(nextScope);
            }
          }}
          size="small"
          value={scope}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="http">HTTP</ToggleButton>
          <ToggleButton value="errors">Errors</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {error ? (
        <Alert severity="error">
          Unable to load proxy runtime state. Capture controls may be stale until the Tauri command layer responds again.
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
          detailErrorMessage={
            sessionDetailError
              ? getOperationErrorMessage(
                  sessionDetailError,
                  "Unable to load the selected session detail from the desktop runtime.",
                )
              : undefined
          }
          inspectorSplitRatio={DEFAULT_REQUEST_SPLIT_RATIO}
          isDetailLoading={isSessionDetailLoading}
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

function clampExplorerWidth(width: number) {
  return Math.min(520, Math.max(280, Math.round(width)));
}

