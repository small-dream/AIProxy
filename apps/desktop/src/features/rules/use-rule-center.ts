import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DnsMappingRule, MapRule, RewriteRule } from "@aiproxy/shared-types";

import {
  deleteRule,
  listDnsMappings,
  listMapRules,
  listRewriteRules,
  saveDnsMapping,
  saveMapRule,
  saveRewriteRule,
} from "@/services/commands";

const REWRITE_RULES_KEY = ["rewrite-rules"] as const;
const MAP_RULES_KEY = ["map-rules"] as const;
const DNS_MAPPINGS_KEY = ["dns-mappings"] as const;

export function useRewriteRules() {
  return useQuery({
    queryKey: REWRITE_RULES_KEY,
    queryFn: () => listRewriteRules(),
    staleTime: Infinity,
  });
}

export function useSaveRewriteRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<RewriteRule, "id"> & { id?: string }) => saveRewriteRule(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REWRITE_RULES_KEY });
    },
  });
}

export function useMapRules(mode?: MapRule["mode"]) {
  return useQuery({
    queryKey: [...MAP_RULES_KEY, mode ?? "all"],
    queryFn: () => listMapRules(mode ? { mode } : undefined),
    staleTime: Infinity,
  });
}

export function useSaveMapRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<MapRule, "id"> & { id?: string }) => saveMapRule(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MAP_RULES_KEY });
    },
  });
}

export function useDnsMappings(workspaceId: string) {
  return useQuery({
    queryKey: [...DNS_MAPPINGS_KEY, workspaceId],
    queryFn: () => listDnsMappings({ workspaceId }),
    staleTime: Infinity,
  });
}

export function useSaveDnsMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<DnsMappingRule, "id"> & { id?: string }) => saveDnsMapping(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DNS_MAPPINGS_KEY });
    },
  });
}

export function useDeleteManagedRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { ruleId: string; ruleType: "rewrite" | "map" | "dns" }) => deleteRule(input),
    onSuccess: (_, input) => {
      if (input.ruleType === "rewrite") {
        queryClient.invalidateQueries({ queryKey: REWRITE_RULES_KEY });
        return;
      }

      if (input.ruleType === "dns") {
        queryClient.invalidateQueries({ queryKey: DNS_MAPPINGS_KEY });
        return;
      }

      queryClient.invalidateQueries({ queryKey: MAP_RULES_KEY });
    },
  });
}
