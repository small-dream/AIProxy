import type { SessionSummary } from "@aiproxy/shared-types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionContainer } from "@/features/sessions/session-containers.helpers";
import {
  FOCUSED_HOSTS_STORAGE_KEY,
  IGNORED_HOSTS_STORAGE_KEY,
  useSessionFilters,
} from "./use-session-filters";

let throttledSessionIds: string[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: throttledSessionIds }),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en-US" }),
}));

vi.mock("@/services/commands", () => ({
  listThrottledSessionIds: vi.fn(),
}));

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 10,
    finishedAt: "2026-04-21T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/users",
    protocol: "HTTP/1.1",
    responseMimeType: "application/json",
    sizeBytes: 10,
    startedAt: "2026-04-21T10:00:00.000Z",
    statusCode: 200,
    url: "http://api.example.com/users",
    ...overrides,
  };
}

function setupHook({
  displayActiveSessions,
  searchValue = "",
}: {
  displayActiveSessions: SessionSummary[];
  searchValue?: string;
}) {
  const updateContainer = vi.fn();

  const { result } = renderHook(() =>
    useSessionFilters({
      displayActiveSessions,
      updateContainer: updateContainer as unknown as (
        updater: (container: SessionContainer) => SessionContainer,
      ) => void,
      searchValue,
    }),
  );

  return { result, updateContainer };
}

beforeEach(() => {
  throttledSessionIds = [];
  // The test environment's localStorage is stubbed out (see the existing
  // pattern in pages/sessions.test.tsx); install an in-memory replacement.
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
});

describe("useSessionFilters — filtering pipeline", () => {
  it("drops sessions whose host is in the ignored-hosts storage list", () => {
    window.localStorage.setItem(IGNORED_HOSTS_STORAGE_KEY, JSON.stringify(["ads.example.com"]));

    const { result } = setupHook({
      displayActiveSessions: [
        createSessionSummary({ host: "ads.example.com", id: "session-1" }),
        createSessionSummary({ host: "api.example.com", id: "session-2" }),
      ],
    });

    expect(result.current.visibleSessions.map((session) => session.id)).toEqual(["session-2"]);
  });

  it("keeps only throttled sessions when showOnlyThrottled is enabled", () => {
    throttledSessionIds = ["session-2"];

    const { result } = setupHook({
      displayActiveSessions: [
        createSessionSummary({ id: "session-1" }),
        createSessionSummary({ id: "session-2" }),
      ],
    });

    act(() => result.current.setShowOnlyThrottled(true));

    expect(result.current.visibleSessions.map((session) => session.id)).toEqual(["session-2"]);
  });

  it("matches the full-field keyword against status code and MIME, not just host", () => {
    const { result } = setupHook({
      displayActiveSessions: [
        createSessionSummary({ host: "api.example.com", id: "session-1", statusCode: 404 }),
        createSessionSummary({ host: "api.example.com", id: "session-2", statusCode: 200 }),
        createSessionSummary({
          host: "cdn.example.com",
          id: "session-3",
          responseMimeType: "text/css",
          statusCode: 200,
        }),
      ],
      // Hits session-1 by status code and session-3 by MIME type — neither
      // matches by host, proving the host-substring filter is gone.
      searchValue: "40",
    });

    expect(result.current.visibleSessions.map((session) => session.id)).toEqual(["session-1"]);
  });

  it("does not read focused hosts into groups when storage is empty", () => {
    expect(window.localStorage.getItem(FOCUSED_HOSTS_STORAGE_KEY)).toBeNull();

    const { result } = setupHook({ displayActiveSessions: [createSessionSummary()] });

    expect(result.current.focusedHosts.size).toBe(0);
    expect(result.current.visibleSessions).toHaveLength(1);
  });
});
