import type { SessionDiffEntry, SessionDiffPayload, SessionDiffSection } from "@aiproxy/shared-types";

const SENSITIVE_KEY_PATTERN = /(authorization|cookie|set-cookie|token|access_token|refresh_token|api[-_]?key|password|passwd|secret|session|jwt)/i;
const REDACTED = "[REDACTED]";

export function redactDiffPayload(payload: SessionDiffPayload): SessionDiffPayload {
  return {
    ...payload,
    redacted: true,
    sections: payload.sections.map(redactSection),
  };
}

export function isSensitivePath(path: string) {
  return SENSITIVE_KEY_PATTERN.test(path);
}

function redactSection(section: SessionDiffSection): SessionDiffSection {
  return {
    ...section,
    entries: section.entries.map(redactEntry),
  };
}

function redactEntry(entry: SessionDiffEntry): SessionDiffEntry {
  if (!isSensitivePath(entry.path)) {
    return entry;
  }

  return {
    ...entry,
    before: entry.before === undefined ? undefined : REDACTED,
    after: entry.after === undefined ? undefined : REDACTED,
  };
}
