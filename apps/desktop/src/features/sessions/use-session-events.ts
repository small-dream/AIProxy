import { useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@pharles/shared-types";
import { useEffect } from "react";

import { onSessionRemove, onSessionUpsert } from "@/services/events";
import { removeSessionSummary, upsertSessionSummary } from "./session-cache.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { SESSIONS_QUERY_KEY } from "./use-sessions";

export function useSessionEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlistenFns: (() => void)[] = [];

    onSessionUpsert((detail) => {
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        upsertSessionSummary(currentSessions, detail.summary),
      );
      queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, detail.id], detail);
    }).then((fn) => {
      unlistenFns.push(fn);
    });

    onSessionRemove((sessionId) => {
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummary(currentSessions, sessionId),
      );
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId] });
    }).then((fn) => {
      unlistenFns.push(fn);
    });

    return () => {
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [queryClient]);
}
