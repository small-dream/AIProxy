import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";

import {
  deleteThrottleRule,
  getThrottleRuntimeStats,
  listThrottleProfiles,
  listThrottleRules,
  saveThrottleProfile,
  saveThrottleRule,
  setActiveThrottleProfile,
} from "@/services/commands";

const THROTTLE_PROFILES_KEY = ["throttle-profiles"] as const;
const THROTTLE_RULES_KEY = ["throttle-rules"] as const;
const THROTTLE_STATS_KEY = ["throttle-runtime-stats"] as const;

export function useThrottleProfiles() {
  return useQuery({
    queryKey: THROTTLE_PROFILES_KEY,
    queryFn: () => listThrottleProfiles(),
    staleTime: Infinity,
  });
}

export function useSaveThrottleProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<ThrottleProfile, "id"> & { id?: string }) =>
      saveThrottleProfile(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_PROFILES_KEY });
    },
    // Surfaced as the editor's profileSaveError alert.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useSetActiveThrottleProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileId?: string) => setActiveThrottleProfile(profileId ? { profileId } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_PROFILES_KEY });
      queryClient.invalidateQueries({ queryKey: THROTTLE_STATS_KEY });
    },
    // Surfaced as the page's setActiveError alert.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useThrottleRules() {
  return useQuery({
    queryKey: THROTTLE_RULES_KEY,
    queryFn: () => listThrottleRules(),
    staleTime: Infinity,
  });
}

export function useSaveThrottleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Omit<ThrottleRule, "id"> & { id?: string }) => saveThrottleRule(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_RULES_KEY });
    },
    // Surfaced as the editor's ruleSaveError alert.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useDeleteThrottleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ruleId: string) => deleteThrottleRule(ruleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_RULES_KEY });
    },
    // Surfaced inside the delete ConfirmDialog while it stays open on failure.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useThrottleRuntimeStats() {
  return useQuery({
    queryKey: THROTTLE_STATS_KEY,
    queryFn: () => getThrottleRuntimeStats(),
    refetchInterval: 2_000,
  });
}
