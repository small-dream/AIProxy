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
 * The key mirrors what the backend derives a path from: host plus the URL path
 * with the query string dropped. It deliberately ignores the MIME-based
 * extension, so this errs toward reporting a conflict — a false positive only
 * shows the user a dialog they could have skipped, whereas a false negative
 * would silently pick a strategy for them.
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
