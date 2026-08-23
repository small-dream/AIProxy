import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { I18nProvider } from "@/i18n";

import { useSessionContextActions } from "./use-session-context-actions";
import { ensureSessionDetailContent } from "./session-detail-content";

vi.mock("./session-detail-content", () => ({
  ensureSessionDetailContent: vi.fn(),
}));

function createSessionSummary(): SessionSummary {
  return {
    durationMs: 48,
    finishedAt: "2026-08-23T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/users",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-08-23T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/users",
  };
}

function buildDetail(summary: SessionSummary): SessionDetail {
  return {
    cookies: [],
    id: summary.id,
    queryParams: [],
    rawRequest: "GET /users HTTP/1.1\nHost: api.example.com\n",
    requestHeaders: [],
    responseBody: {
      inlineText: '{"ok":true}',
      mimeType: "application/json",
      sizeBytes: 11,
    },
    responseHeaders: [],
    summary,
  };
}

function renderActionsHook() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{children}</I18nProvider>
    </QueryClientProvider>
  );
  return renderHook(
    () =>
      useSessionContextActions({
        loadFromSession: vi.fn(),
        navigate: vi.fn(),
        setFocusedHosts: vi.fn(),
        setIgnoredHosts: vi.fn(),
      }),
    { wrapper },
  );
}

// P2 4.3-9: the copy-family context menu handlers run fire-and-forget from a
// click; a hydration or clipboard failure must surface as a snackbar instead
// of leaking an unhandled promise rejection.
describe("useSessionContextActions copy failure handling", () => {
  beforeEach(() => {
    vi.mocked(ensureSessionDetailContent).mockReset();
    useAppPreferencesStore.setState({ languagePreference: "en" });
  });

  it("reports a snackbar when request detail hydration fails", async () => {
    vi.mocked(ensureSessionDetailContent).mockRejectedValue(new Error("command failed"));
    const { result } = renderActionsHook();

    await act(async () => {
      await result.current.handleCopyRequest(createSessionSummary());
    });

    expect(result.current.snackbarMessage).toBe("Copy failed");
  });

  it("reports a snackbar when the clipboard write rejects", async () => {
    vi.mocked(ensureSessionDetailContent).mockResolvedValue(buildDetail(createSessionSummary()));
    const writeText = vi.fn(() => Promise.reject(new Error("document not focused")));
    Object.assign(navigator, { clipboard: { writeText } });
    const { result } = renderActionsHook();

    try {
      await act(async () => {
        await result.current.handleCopyRequest(createSessionSummary());
      });
    } finally {
      // @ts-expect-error -- jsdom has no clipboard; undo the test stub.
      delete navigator.clipboard;
    }

    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.snackbarMessage).toBe("Copy failed");
    });
  });
});
