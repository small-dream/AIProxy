import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_PROXY_PORT, type ProxyStatus, type StartProxyInput } from "@aiproxy/shared-types";

import {
  clearSessions,
  deleteSessionsExcept,
  disableSystemProxy,
  enableSystemProxy,
  getBootstrapStatus,
  startProxy,
  stopProxy,
} from "@/services/commands";
import { logDevError, logDevInfo } from "@/services/logger/dev-logger";
import { SESSIONS_QUERY_KEY } from "@/features/sessions/use-sessions";
import { WORKSPACES_KEY } from "@/features/workspace-manager/use-workspaces";

import { isPortInUseError, readPortFromError } from "./proxy-start.helpers";
import { useProxyStartStore } from "./proxy-start.store";

// Exported so command flows that mutate proxy state (e.g. certificate removal)
// can invalidate the shared status cache.
export const PROXY_STATUS_QUERY_KEY = ["proxy-status"] as const;
const SESSION_DETAIL_QUERY_KEY = ["session-detail"] as const;

export function useProxyStatus() {
  return useQuery({
    queryFn: getBootstrapStatus,
    queryKey: PROXY_STATUS_QUERY_KEY,
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
  });
}

export function useStartProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: StartProxyInput) => startProxy(input),
    onError: (error, input) => {
      logDevError("ui.proxy_status", "start_proxy_mutation_failed", {
        error,
        input,
      });
      // Surface port conflicts to the shared store so every UI surface
      // (status bar, SetupChecklistCard) reflects them consistently.
      if (isPortInUseError(error)) {
        useProxyStartStore
          .getState()
          .setPortInUse({ port: readPortFromError(error, input.port ?? DEFAULT_PROXY_PORT) });
      }
    },
    onSuccess: (status: ProxyStatus) => {
      logDevInfo("ui.proxy_status", "start_proxy_mutation_succeeded", status);
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      useProxyStartStore.getState().clearPortInUse();
    },
  });
}

export function useStopProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => stopProxy({ workspaceId }),
    onError: (error, workspaceId) => {
      logDevError("ui.proxy_status", "stop_proxy_mutation_failed", {
        error,
        workspaceId,
      });
    },
    onSuccess: (status: ProxyStatus) => {
      logDevInfo("ui.proxy_status", "stop_proxy_mutation_succeeded", status);
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

export function useEnableSystemProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: enableSystemProxy,
    onError: (error) => {
      logDevError("ui.proxy_status", "enable_system_proxy_mutation_failed", {
        error,
      });
    },
    onSuccess: (status: ProxyStatus) => {
      logDevInfo("ui.proxy_status", "enable_system_proxy_mutation_succeeded", status);
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
      // The backend persists `system_proxy_enabled` on the workspace; refresh
      // the cached list so the next launch knows to restore the system proxy.
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}

export function useDisableSystemProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: disableSystemProxy,
    onError: (error) => {
      logDevError("ui.proxy_status", "disable_system_proxy_mutation_failed", {
        error,
      });
    },
    onSuccess: (status: ProxyStatus) => {
      logDevInfo("ui.proxy_status", "disable_system_proxy_mutation_succeeded", status);
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}

export function useClearSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearSessions,
    onError: (error) => {
      logDevError("ui.sessions", "clear_sessions_mutation_failed", {
        error,
      });
    },
    onSuccess: () => {
      queryClient.setQueryData(SESSIONS_QUERY_KEY, []);
      queryClient.removeQueries({ queryKey: SESSION_DETAIL_QUERY_KEY });
      logDevInfo("ui.sessions", "clear_sessions_mutation_succeeded");
    },
  });
}

export function useDeleteSessionsExcept() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteSessionsExcept,
    onError: (error) => {
      logDevError("ui.sessions", "delete_sessions_except_mutation_failed", {
        error,
      });
    },
    onSuccess: () => {
      logDevInfo("ui.sessions", "delete_sessions_except_mutation_succeeded");
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      queryClient.removeQueries({ queryKey: SESSION_DETAIL_QUERY_KEY });
    },
  });
}
