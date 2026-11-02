import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

const MAX_IMPORTED_SESSION_DETAILS = 100;
const importedSessionDetails = new Map<string, SessionDetail>();

export function clearImportedSessions() {
  importedSessionDetails.clear();
}

export function getImportedSessionDetail(sessionId: string) {
  return importedSessionDetails.get(sessionId);
}

export function hasImportedSession(sessionId: string) {
  return importedSessionDetails.has(sessionId);
}

export function keepOnlyImportedSession(sessionId: string) {
  for (const importedSessionId of importedSessionDetails.keys()) {
    if (importedSessionId !== sessionId) {
      importedSessionDetails.delete(importedSessionId);
    }
  }
}

export function removeImportedSessions(sessionIds: string[]) {
  for (const sessionId of sessionIds) {
    importedSessionDetails.delete(sessionId);
  }
}

export function listImportedSessionSummaries(): SessionSummary[] {
  return Array.from(importedSessionDetails.values(), (detail) => detail.summary);
}

/**
 * Insert imported details and evict the oldest beyond the cap.
 *
 * Returns the ids that were evicted so callers can drop their summaries and
 * cached details too. Without that, the list kept showing sessions whose
 * detail had been evicted (opening them failed, whole-selection exports broke)
 * — a summary without a detail is not a session the app can serve (P2-26).
 */
export function upsertImportedSessions(details: SessionDetail[]): string[] {
  for (const detail of details) {
    importedSessionDetails.set(detail.id, detail);
  }
  const evicted: string[] = [];
  while (importedSessionDetails.size > MAX_IMPORTED_SESSION_DETAILS) {
    const oldestKey = importedSessionDetails.keys().next().value;
    if (oldestKey === undefined) break;
    importedSessionDetails.delete(oldestKey);
    evicted.push(oldestKey);
  }
  return evicted;
}
