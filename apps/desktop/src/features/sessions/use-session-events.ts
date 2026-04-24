import { useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@aiproxy/shared-types";
import { useEffect } from "react";

import { onSessionRemove, onSessionsCleared, onSessionsRemoved, onSessionUpsert } from "@/services/events";
import { removeSessionSummaries, removeSessionSummary, upsertSessionSummary } from "./session-cache.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { SESSIONS_QUERY_KEY } from "./use-sessions";

export function useSessionEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: (() => void)[] = [];

    onSessionUpsert((summary) => {
      if (cancelled) return;
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        upsertSessionSummary(currentSessions, summary),
      );
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: [SESSION_DETAIL_QUERY_KEY, summary.id],
      });
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionRemove((sessionId) => {
      if (cancelled) return;
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummary(currentSessions, sessionId),
      );
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId] });
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionsCleared((ids) => {
      if (cancelled) return;
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, []);
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    onSessionsRemoved((ids) => {
      if (cancelled) return;
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummaries(currentSessions, ids),
      );
      for (const id of ids) {
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, id] });
      }
    }).then((fn) => {
      if (!cancelled) {
        unlistenFns.push(fn);
      } else {
        fn();
      }
    });

    return () => {
      cancelled = true;
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [queryClient]);
}
