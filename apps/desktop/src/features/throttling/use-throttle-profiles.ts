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

export const THROTTLE_PROFILES_QUERY_KEY = ["throttle-profiles"] as const;
export const THROTTLE_RULES_QUERY_KEY = ["throttle-rules"] as const;
export const THROTTLE_STATS_QUERY_KEY = ["throttle-runtime-stats"] as const;

const THROTTLE_PROFILES_KEY = THROTTLE_PROFILES_QUERY_KEY;
const THROTTLE_RULES_KEY = THROTTLE_RULES_QUERY_KEY;
const THROTTLE_STATS_KEY = THROTTLE_STATS_QUERY_KEY;

/** Upsert one saved profile into the cached list (by id). */
function upsertById<T extends { id: string }>(list: T[], saved: T): T[] {
  const index = list.findIndex((item) => item.id === saved.id);
  if (index === -1) {
    return [...list, saved];
  }
  const next = list.slice();
  next[index] = saved;
  return next;
}

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
    onSuccess: (saved) => {
      // N-1: write the saved profile into the cache IMMEDIATELY, before the
      // invalidate-triggered refetch lands. The editor's auto-select effect
      // guards on `profiles.some(id === selectedProfileId)`; with a stale
      // list at the moment the save succeeds, a freshly saved profile's
      // selection snapped back to the previously active profile (and a
      // further save would overwrite ITS data — the same class of bug H-1
      // fixed for handleNewProfile).
      queryClient.setQueryData<ThrottleProfile[]>(THROTTLE_PROFILES_KEY, (current) =>
        current ? upsertById(current, saved) : [saved],
      );
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
    onSuccess: (saved) => {
      // N-1: same synchronous cache write as useSaveThrottleProfile — the
      // rule editor's draft-sync effects read the rules list the instant the
      // per-mutation onSuccess runs, and invalidate alone leaves that list
      // stale for one render.
      queryClient.setQueryData<ThrottleRule[]>(THROTTLE_RULES_KEY, (current) =>
        current ? upsertById(current, saved) : [saved],
      );
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
