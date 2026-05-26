import type { SessionSummary } from "@aiproxy/shared-types";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSessionContainerStore } from "./session-container.store";
import { upsertSessionSummary, removeSessionSummary, removeSessionSummaries } from "./session-cache.helpers";
import { SESSIONS_QUERY_KEY } from "./use-sessions";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import {
  onSessionUpsert,
  onSessionRemove,
  onSessionsCleared,
  onSessionsRemoved,
} from "@/services/events";

const FLUSH_INTERVAL_MS = 100;

export function useSessionEvents() {
  const store = useSessionContainerStore;
  const queryClient = useQueryClient();
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    let upsertBuffer: SessionSummary[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushUpsertBuffer() {
      if (upsertBuffer.length === 0) return;
      const batch = upsertBuffer;
      upsertBuffer = [];
      flushTimer = null;

      for (const summary of batch) {
        storeRef.current.getState().upsertSummary(summary);
      }

      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) => {
        let updated = currentSessions;
        for (const summary of batch) {
          updated = upsertSessionSummary(updated, summary);
        }
        return updated;
      });

      for (const summary of batch) {
        void queryClient.invalidateQueries({
          exact: true,
          queryKey: [SESSION_DETAIL_QUERY_KEY, summary.id],
        });
      }
    }

    onSessionUpsert((summary) => {
      if (cancelled) return;
      upsertBuffer.push(summary);
      if (!flushTimer) {
        flushTimer = setTimeout(flushUpsertBuffer, FLUSH_INTERVAL_MS);
      }
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionRemove((sessionId) => {
      if (cancelled) return;
      storeRef.current.getState().removeSummary(sessionId);
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummary(currentSessions, sessionId),
      );
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId] });
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionsCleared(() => {
      if (cancelled) return;
      upsertBuffer = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      storeRef.current.getState().clearSessions();
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, []);
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionsRemoved((ids) => {
      if (cancelled) return;
      for (const id of ids) {
        storeRef.current.getState().removeSummary(id);
      }
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummaries(currentSessions, ids),
      );
      for (const id of ids) {
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, id] });
      }
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    return () => {
      cancelled = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushUpsertBuffer();
      }
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [queryClient]);
}
