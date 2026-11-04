import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ClearAgentAutomationInput,
  RollbackAutomationChangeInput,
} from "@aiproxy/shared-types";

import { AGENT_SETTINGS_QUERY_KEY } from "@/features/agent-access/agent-access-query-keys";
import { MAP_RULES_QUERY_KEY, REWRITE_RULES_QUERY_KEY } from "@/features/rules/use-rule-center";
import {
  clearAgentAutomation,
  getAutomationChange,
  listAutomationChanges,
  promoteAutomationChange,
  rollbackAutomationChange,
} from "@/services/commands";

import { AUTOMATION_CHANGE_QUERY_KEY, AUTOMATION_CHANGES_QUERY_KEY } from "./automation-query-keys";

function useInvalidateAutomation() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: AUTOMATION_CHANGES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: AUTOMATION_CHANGE_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: REWRITE_RULES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: MAP_RULES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY }),
    ]);
}

export function useAutomationChanges(limit = 20) {
  return useQuery({
    queryKey: [...AUTOMATION_CHANGES_QUERY_KEY, limit],
    queryFn: () => listAutomationChanges(limit),
    staleTime: Infinity,
  });
}

export function useAutomationChange(changeId: string | null) {
  return useQuery({
    queryKey: [...AUTOMATION_CHANGE_QUERY_KEY, changeId],
    queryFn: () => getAutomationChange(changeId!),
    enabled: Boolean(changeId),
    staleTime: Infinity,
  });
}

export function useRollbackAutomationChange() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (input: RollbackAutomationChangeInput) => rollbackAutomationChange(input),
    onSuccess: invalidate,
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function usePromoteAutomationChange() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (changeId: string) => promoteAutomationChange(changeId),
    onSuccess: invalidate,
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useClearAgentAutomation() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (input: ClearAgentAutomationInput) => clearAgentAutomation(input),
    onSuccess: invalidate,
    meta: { suppressGlobalErrorNotification: true },
  });
}
