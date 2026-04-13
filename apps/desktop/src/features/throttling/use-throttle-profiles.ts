import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThrottleProfile } from "@pharles/shared-types";

import {
  listThrottleProfiles,
  saveThrottleProfile,
  setActiveThrottleProfile,
} from "@/services/commands";

const THROTTLE_PROFILES_KEY = ["throttle-profiles"] as const;

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
    mutationFn: (input: Omit<ThrottleProfile, "id"> & { id?: string }) => saveThrottleProfile(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_PROFILES_KEY });
    },
  });
}

export function useSetActiveThrottleProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileId?: string) =>
      setActiveThrottleProfile(profileId ? { profileId } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: THROTTLE_PROFILES_KEY });
    },
  });
}
