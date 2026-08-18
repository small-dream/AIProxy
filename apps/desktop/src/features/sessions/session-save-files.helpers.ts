import type { SessionSummary } from "@aiproxy/shared-types";

import { isWebSocketSessionProtocol } from "@/features/sessions/session-protocol.helpers";

/**
 * Requests that can produce a file on disk. WebSocket sessions are message
 * streams rather than a single payload, and the backend skips them too —
 * filtering here keeps the count shown to the user honest.
 */
export function getSaveableSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.filter((session) => !isWebSocketSessionProtocol(session));
}

/**
 * Whether two or more requests would land on the same file, which is the only
 * situation where the conflict strategy changes the outcome.
 *
 * This is a heuristic precheck, deliberately NOT a mirror of the backend's
 * path derivation. The key is host plus the raw URL path with the query string
 * dropped, so it catches the common case (same path, different query) but
 * under-reports: the backend also collapses dot segments, percent-decodes,
 * appends MIME-derived extensions, maps directory URLs to `index.<ext>`, and
 * truncates over-long segments — any of which can collide two requests this
 * check considers distinct.
 *
 * A miss is safe but opinionated: the strategy dialog is skipped and the save
 * runs with `keepAll`, so no data is lost — the user just does not get to pick
 * `latestOnly` for a collision we did not predict. Keep it that way rather
 * than duplicating the Rust sanitization here and having the two drift.
 */
export function hasSaveTargetConflicts(sessions: SessionSummary[]): boolean {
  const seenTargets = new Set<string>();

  for (const session of sessions) {
    const target = `${session.host}${stripQueryString(session.path)}`;

    if (seenTargets.has(target)) {
      return true;
    }

    seenTargets.add(target);
  }

  return false;
}

function stripQueryString(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}
