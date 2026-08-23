import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listBreakpointRules, setBreakpointRules } from "@/services/commands";

const BREAKPOINT_RULES_KEY = ["breakpoint-rules"] as const;

export function useBreakpointRules() {
  return useQuery({
    queryKey: BREAKPOINT_RULES_KEY,
    queryFn: listBreakpointRules,
    refetchInterval: false,
    staleTime: Infinity,
  });
}

export function useSetBreakpointRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rules: Parameters<typeof setBreakpointRules>[0]) => setBreakpointRules(rules),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BREAKPOINT_RULES_KEY });
    },
    // Surfaced as the panel's saveError alert.
    meta: { suppressGlobalErrorNotification: true },
  });
}
