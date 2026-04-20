import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiEnvironmentVariable } from "@aiproxy/shared-types";

import {
  deleteApiEnvironment,
  listApiEnvironmentVariables,
  listApiEnvironments,
  setApiEnvironmentVariables,
  upsertApiEnvironment,
} from "@/services/commands";

const ENV_KEY = ["api-environments"];

export function useEnvironments() {
  return useQuery({
    queryKey: ENV_KEY,
    queryFn: listApiEnvironments,
  });
}

export function useUpsertEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; name: string; sortOrder?: number }) =>
      upsertApiEnvironment(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ENV_KEY });
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiEnvironment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ENV_KEY });
      queryClient.invalidateQueries({ queryKey: ["api-environment-variables"] });
    },
  });
}

export function useEnvironmentVariables(environmentId: string | null) {
  return useQuery({
    queryKey: ["api-environment-variables", environmentId],
    queryFn: () => (environmentId ? listApiEnvironmentVariables(environmentId) : []),
    enabled: !!environmentId,
  });
}

export function useSetEnvironmentVariables() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      environmentId,
      variables,
    }: {
      environmentId: string;
      variables: Array<{
        id: string;
        key: string;
        value: string;
        enabled: boolean;
        sortOrder?: number;
      }>;
    }) => setApiEnvironmentVariables(environmentId, variables),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["api-environment-variables", variables.environmentId],
      });
    },
  });
}

/**
 * Substitute {{key}} placeholders in a template string.
 */
export function substituteVariables(
  template: string,
  variables: ApiEnvironmentVariable[],
): string {
  const enabled = variables.filter((v) => v.enabled);
  let result = template;
  for (const v of enabled) {
    const pattern = `{{${v.key}}}`;
    result = result.replaceAll(pattern, v.value);
  }
  return result;
}

/**
 * Build a Map of enabled variables for quick lookup.
 */
export function buildVariableMap(
  variables: ApiEnvironmentVariable[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of variables) {
    if (v.enabled) {
      map.set(v.key, v.value);
    }
  }
  return map;
}
