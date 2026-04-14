import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  updateWorkspace,
} from "@/services/commands";

const WORKSPACES_KEY = ["workspaces"] as const;
const PROXY_STATUS_KEY = ["proxy-status"] as const;

export function useWorkspaces() {
  return useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => listWorkspaces(),
    staleTime: Infinity,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; proxyPort: number; sslEnabled?: boolean }) =>
      createWorkspace(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}

export function useLoadWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => loadWorkspace(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROXY_STATUS_KEY });
    },
  });
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      workspaceId: string;
      name?: string;
      proxyPort?: number;
      sslEnabled?: boolean;
    }) => updateWorkspace(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}
