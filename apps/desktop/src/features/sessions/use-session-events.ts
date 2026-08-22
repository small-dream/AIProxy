import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSessionContainerStore } from "./session-container.store";
import {
  upsertSessionSummary,
  removeSessionSummary,
  removeSessionSummaries,
} from "./session-cache.helpers";
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
  const queryClient = useQueryClient();

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
        useSessionContainerStore.getState().upsertSummary(summary);
      }

      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) => {
        let updated = currentSessions;
        for (const summary of batch) {
          updated = upsertSessionSummary(updated, summary);
        }
        return updated;
      });

      for (const summary of batch) {
        // P1-18: merge the fresh summary into an already-cached detail instead
        // of invalidating it. A blind invalidate marked the entry stale on
        // every upsert of every session at batch frequency, refetching details
        // nobody is inspecting and re-parsing the inspector's memos. When
        // nothing is cached there is no consumer — an inspector that opens
        // later fetches on mount — so skip entirely.
        const existingDetail = queryClient.getQueryData<SessionDetail>([
          SESSION_DETAIL_QUERY_KEY,
          summary.id,
        ]);
        if (!existingDetail) continue;
        const completedNow = existingDetail.summary.statusCode <= 0 && summary.statusCode > 0;
        queryClient.setQueryData<SessionDetail>([SESSION_DETAIL_QUERY_KEY, summary.id], {
          ...existingDetail,
          summary,
        });
        if (!completedNow) continue;
        // The backend refreshes its cached detail in place when a captured
        // request completes (the response body arrives), and a summary-only
        // merge cannot carry that body over. Invalidate once on the
        // in-flight→completed transition so an open inspector refetches the
        // full detail; later upserts see a completed cached summary and never
        // reach this point, keeping the old batch-frequency refetch storm out.
        queryClient.invalidateQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, summary.id] });
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
      useSessionContainerStore.getState().removeSummary(sessionId);
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
      useSessionContainerStore.getState().clearSessions();
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, []);
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionsRemoved((ids) => {
      if (cancelled) return;
      for (const id of ids) {
        useSessionContainerStore.getState().removeSummary(id);
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
