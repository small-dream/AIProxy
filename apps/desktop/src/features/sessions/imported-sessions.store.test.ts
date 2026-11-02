import type { SessionDetail } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearImportedSessions,
  hasImportedSession,
  upsertImportedSessions,
} from "./imported-sessions.store";

function importedDetail(id: string): SessionDetail {
  // The store only reads `id` and `summary`; the rest of the detail is carried
  // verbatim for the inspector and is irrelevant to eviction.
  return { id, summary: { id } } as unknown as SessionDetail;
}

describe("imported sessions store", () => {
  beforeEach(() => {
    clearImportedSessions();
  });

  it("returns the ids evicted by the memory cap", () => {
    const details = Array.from({ length: 105 }, (_, index) => importedDetail(`imported-${index}`));

    const evicted = upsertImportedSessions(details);

    expect(evicted).toEqual(Array.from({ length: 5 }, (_, index) => `imported-${index}`));
    expect(hasImportedSession("imported-0")).toBe(false);
    expect(hasImportedSession("imported-4")).toBe(false);
    expect(hasImportedSession("imported-5")).toBe(true);
    expect(hasImportedSession("imported-104")).toBe(true);
  });
});
