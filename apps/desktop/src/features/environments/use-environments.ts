import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiEnvironmentVariable, ApiGlobalVariable } from "@aiproxy/shared-types";

import {
  deleteApiEnvironment,
  listApiEnvironmentVariables,
  listApiEnvironments,
  listApiGlobalVariables,
  setApiEnvironmentVariables,
  setApiGlobalVariables,
  upsertApiEnvironment,
} from "@/services/commands";

const ENV_KEY = ["api-environments"];
const GLOBAL_VARS_KEY = ["api-global-variables"];

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

export function useGlobalVariables() {
  return useQuery({
    queryKey: GLOBAL_VARS_KEY,
    queryFn: listApiGlobalVariables,
  });
}

export function useSetGlobalVariables() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      variables: Array<{
        id: string;
        key: string;
        value: string;
        enabled: boolean;
        sortOrder?: number;
      }>,
    ) => setApiGlobalVariables(variables),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GLOBAL_VARS_KEY });
    },
  });
}

/**
 * Build a Map of enabled variables, with environment variables
 * taking precedence over global variables.
 */
export function buildMergedVariableMap(
  envVariables: ApiEnvironmentVariable[],
  globalVariables: ApiGlobalVariable[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of globalVariables) {
    if (v.enabled) map.set(v.key, v.value);
  }
  for (const v of envVariables) {
    if (v.enabled) map.set(v.key, v.value);
  }
  return map;
}

/**
 * Substitute {{key}} placeholders in a template string.
 */
export function substituteVariables(
  template: string,
  variables: ApiEnvironmentVariable[] | Map<string, string>,
): string {
  if (variables instanceof Map) {
    let result = template;
    for (const [key, value] of variables) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
  }
  const enabled = variables.filter((v) => v.enabled);
  let result = template;
  for (const v of enabled) {
    result = result.replaceAll(`{{${v.key}}}`, v.value);
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
