import { useQuery } from "@tanstack/react-query";

import { listSessions } from "@/services/commands";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

export { SESSIONS_QUERY_KEY };

export function useSessions() {
  return useQuery({
    queryFn: listSessions,
    queryKey: SESSIONS_QUERY_KEY,
  });
}
