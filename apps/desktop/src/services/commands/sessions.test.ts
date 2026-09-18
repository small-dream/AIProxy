import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: vi.fn(),
  reportCommandFailure: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clearImportedSessions,
  listImportedSessionSummaries,
  upsertImportedSessions,
} from "@/features/sessions/imported-sessions.store";
import { isTauriRuntime, reportCommandFailure } from "./runtime";
import { deleteSessions, deleteSessionsExcept, isCapturedSessionNotFoundError } from "./sessions";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    method: "GET",
    host: "api.example.com",
    path: "/users",
    protocol: "https",
    startedAt: "2026-05-14T00:00:00.000Z",
    finishedAt: "2026-05-14T00:00:01.000Z",
    durationMs: 100,
    sizeBytes: 128,
    statusCode: 200,
    url: "https://api.example.com/users",
    ...overrides,
  };
}

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const baseSummary = overrides.summary ?? summary();
  return {
    id: baseSummary.id,
    summary: baseSummary,
    cookies: [],
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    ...overrides,
  };
}

describe("isCapturedSessionNotFoundError", () => {
  it("detects structured session not found errors", () => {
    expect(
      isCapturedSessionNotFoundError({
        code: "SESSION_NOT_FOUND",
        message: "Captured session session-1 was not found.",
      }),
    ).toBe(true);
  });

  it("does not infer session not found from unstructured strings", () => {
    expect(isCapturedSessionNotFoundError("captured session session-1 was not found")).toBe(false);
  });
});

describe("deleteSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImportedSessions();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
  });

  afterEach(() => {
    clearImportedSessions();
    vi.restoreAllMocks();
  });

  it("invokes delete_sessions with the requested ids", async () => {
    await deleteSessions(["session-1", "session-2"]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("delete_sessions", {
      input: { sessionIds: ["session-1", "session-2"] },
    });
  });

  it("bypasses invoke in non-Tauri runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);

    await deleteSessions(["session-1"]);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops matching imported sessions so a later refetch cannot resurrect them", async () => {
    upsertImportedSessions([
      detail({ id: "imported-1", summary: summary({ id: "imported-1" }) }),
      detail({ id: "imported-2", summary: summary({ id: "imported-2" }) }),
    ]);

    await deleteSessions(["imported-1"]);

    expect(listImportedSessionSummaries().map((s) => s.id)).toEqual(["imported-2"]);
  });

  it("reports and rethrows backend failures", async () => {
    const failure = { code: "DB_POISONED", message: "db lock poisoned" };
    vi.mocked(invoke).mockRejectedValueOnce(failure);

    await expect(deleteSessions(["session-1"])).rejects.toMatchObject({ code: "DB_POISONED" });
    expect(reportCommandFailure).toHaveBeenCalledWith("delete_sessions", failure);
  });
});

describe("deleteSessionsExcept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImportedSessions();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
  });

  afterEach(() => {
    clearImportedSessions();
    vi.restoreAllMocks();
  });

  it("invokes delete_sessions_except with the kept id", async () => {
    await deleteSessionsExcept("keep-1");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("delete_sessions_except", {
      input: { keepSessionId: "keep-1" },
    });
  });

  it("bypasses invoke in non-Tauri runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);

    await deleteSessionsExcept("keep-1");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps only the kept imported session", async () => {
    upsertImportedSessions([
      detail({ id: "keep-1", summary: summary({ id: "keep-1" }) }),
      detail({ id: "imported-2", summary: summary({ id: "imported-2" }) }),
    ]);

    await deleteSessionsExcept("keep-1");

    expect(listImportedSessionSummaries().map((s) => s.id)).toEqual(["keep-1"]);
  });
});
