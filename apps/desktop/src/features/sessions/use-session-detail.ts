import { useIsFetching, useQuery } from "@tanstack/react-query";

import { getSessionDetail, isCapturedSessionNotFoundError } from "@/services/commands";

const SESSION_DETAIL_QUERY_KEY = "session-detail";

export { SESSION_DETAIL_QUERY_KEY };

export function useSessionDetail(sessionId: string | undefined) {
  return useQuery({
    enabled: Boolean(sessionId),
    queryFn: () => getSessionDetail(sessionId as string),
    queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId],
    retry: (_failureCount, error) => !isCapturedSessionNotFoundError(error),
  });
}

/**
 * Whether the detail query for the given session is currently fetching — either
 * its initial load or a background refetch (e.g. triggered by a session-upsert
 * event when the request completes). Reactive: re-renders when the fetch state
 * changes, so callers can tell a body that genuinely is empty apart from one
 * that simply has not loaded yet.
 */
export function useSessionDetailFetching(sessionId: string | undefined): boolean {
  return (
    useIsFetching({
      exact: true,
      queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId],
    }) > 0
  );
}
