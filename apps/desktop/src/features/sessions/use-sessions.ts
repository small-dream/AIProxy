import { useQuery } from "@tanstack/react-query";

import { listSessions } from "@/services/commands";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

export function useSessions(pollingEnabled: boolean) {
  return useQuery({
    queryFn: listSessions,
    queryKey: SESSIONS_QUERY_KEY,
    refetchInterval: pollingEnabled ? 1_000 : false,
  });
}
