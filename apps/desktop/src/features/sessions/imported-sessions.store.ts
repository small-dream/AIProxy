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

export function listImportedSessionSummaries(): SessionSummary[] {
  return Array.from(importedSessionDetails.values(), (detail) => detail.summary);
}

export function upsertImportedSessions(details: SessionDetail[]) {
  for (const detail of details) {
    importedSessionDetails.set(detail.id, detail);
  }
  while (importedSessionDetails.size > MAX_IMPORTED_SESSION_DETAILS) {
    const oldestKey = importedSessionDetails.keys().next().value;
    if (oldestKey !== undefined) importedSessionDetails.delete(oldestKey);
  }
}
