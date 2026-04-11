import { useQuery } from "@tanstack/react-query";

import { getSessionDetail } from "@/services/commands";

const SESSION_DETAIL_QUERY_KEY = "session-detail";

export function useSessionDetail(sessionId: string | undefined) {
  return useQuery({
    enabled: Boolean(sessionId),
    queryFn: () => getSessionDetail(sessionId as string),
    queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId],
  });
}
