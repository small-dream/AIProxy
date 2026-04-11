import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProxyStatus, StartProxyInput } from "@pharles/shared-types";

import { getBootstrapStatus, startProxy, stopProxy } from "@/services/commands";

const PROXY_STATUS_QUERY_KEY = ["proxy-status"] as const;

export function useProxyStatus() {
  return useQuery({
    queryFn: getBootstrapStatus,
    queryKey: PROXY_STATUS_QUERY_KEY,
  });
}

export function useStartProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: StartProxyInput) => startProxy(input),
    onSuccess: (status: ProxyStatus) => {
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
    },
  });
}

export function useStopProxy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => stopProxy({ workspaceId }),
    onSuccess: (status: ProxyStatus) => {
      queryClient.setQueryData(PROXY_STATUS_QUERY_KEY, status);
    },
  });
}

