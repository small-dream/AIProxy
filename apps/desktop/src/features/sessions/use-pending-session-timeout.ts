import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "@aiproxy/shared-types";

import {
  markTimedOutPendingSession,
  PENDING_SESSION_TIMEOUT_MS,
} from "@/features/sessions/session-cache.helpers";
import { logDevWarn } from "@/services/logger/dev-logger";

export interface PendingSessionTimeoutState {
  locallyTimedOutSessionIds: Set<string>;
  pendingTimeoutNowMs: number;
  displayActiveSessions: SessionSummary[];
  /** Let the page manually mark a session as locally timed out (e.g. when its
   *  detail query returns 404/NotFound while the session is still pending). */
  markSessionLocallyTimedOut: (sessionId: string) => void;
}

export interface UsePendingSessionTimeoutParams {
  activeSessions: SessionSummary[];
}

export function usePendingSessionTimeout({
  activeSessions,
}: UsePendingSessionTimeoutParams): PendingSessionTimeoutState {
  const [locallyTimedOutSessionIds, setLocallyTimedOutSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingTimeoutNowMs, setPendingTimeoutNowMs] = useState(() => Date.now());

  const displayActiveSessions = useMemo(
    () =>
      activeSessions.map((session) =>
        locallyTimedOutSessionIds.has(session.id)
          ? markTimedOutPendingSession(session, pendingTimeoutNowMs, 0)
          : markTimedOutPendingSession(session, pendingTimeoutNowMs),
      ),
    [activeSessions, locallyTimedOutSessionIds, pendingTimeoutNowMs],
  );

  // Clean up timed-out IDs when pending sessions complete
  useEffect(() => {
    const activePendingIds = new Set(
      activeSessions.filter((session) => session.statusCode <= 0).map((session) => session.id),
    );

    setLocallyTimedOutSessionIds((currentIds) => {
      const nextIds = new Set(
        Array.from(currentIds).filter((sessionId) => activePendingIds.has(sessionId)),
      );

      return nextIds.size === currentIds.size ? currentIds : nextIds;
    });
  }, [activeSessions]);

  // Timeout effect: schedule the next timeout check
  useEffect(() => {
    let nextDelayMs: number | undefined;

    for (const session of activeSessions) {
      if (session.statusCode > 0 || locallyTimedOutSessionIds.has(session.id)) {
        continue;
      }

      const startedAtMs = Date.parse(session.startedAt);
      if (!Number.isFinite(startedAtMs)) {
        continue;
      }

      const delayMs = Math.max(0, startedAtMs + PENDING_SESSION_TIMEOUT_MS - pendingTimeoutNowMs);
      nextDelayMs = nextDelayMs === undefined ? delayMs : Math.min(nextDelayMs, delayMs);
    }

    if (nextDelayMs === undefined) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const nowMs = Date.now();
      const timedOutSessions = activeSessions.filter((session) => {
        if (session.statusCode > 0 || locallyTimedOutSessionIds.has(session.id)) {
          return false;
        }

        const startedAtMs = Date.parse(session.startedAt);
        return Number.isFinite(startedAtMs) && startedAtMs + PENDING_SESSION_TIMEOUT_MS <= nowMs;
      });

      for (const session of timedOutSessions) {
        logDevWarn("ui.sessions", "pending_session_timed_out_locally", {
          ageMs: nowMs - Date.parse(session.startedAt),
          host: session.host,
          method: session.method,
          path: session.path,
          sessionId: session.id,
          timeoutMs: PENDING_SESSION_TIMEOUT_MS,
          url: session.url,
        });
      }

      // Record timed-out IDs so the next effect run skips them instead of
      // re-scheduling a 0 ms timeout that would log and set-state again.
      if (timedOutSessions.length > 0) {
        setLocallyTimedOutSessionIds((prev) => {
          const next = new Set(prev);
          for (const s of timedOutSessions) {
            next.add(s.id);
          }
          return next;
        });
      }

      setPendingTimeoutNowMs(nowMs);
    }, nextDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [activeSessions, locallyTimedOutSessionIds, pendingTimeoutNowMs]);

  const markSessionLocallyTimedOut = useCallback((sessionId: string) => {
    setLocallyTimedOutSessionIds((prev) => new Set(prev).add(sessionId));
  }, []);

  return {
    locallyTimedOutSessionIds,
    pendingTimeoutNowMs,
    displayActiveSessions,
    markSessionLocallyTimedOut,
  };
}
