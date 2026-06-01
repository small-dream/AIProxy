import { QueryClient } from "@tanstack/react-query";
import type { SessionDetail } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { ensureSessionDetailContent } from "./session-detail-content";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { getSessionDetailContent } from "@/services/commands";

vi.mock("@/services/commands", () => ({
  getSessionDetail: vi.fn(),
  getSessionDetailContent: vi.fn(),
  isCapturedSessionNotFoundError: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SESSION_NOT_FOUND",
}));

describe("ensureSessionDetailContent", () => {
  it("keeps cached detail and clears deferred flags when the captured session is stale", async () => {
    const queryClient = new QueryClient();
    const detail = createSessionDetail({
      rawResponseDeferred: true,
      responseBody: {
        mimeType: "application/json",
        sizeBytes: 15,
        textDeferred: true,
      },
    });

    queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, detail.id], detail);
    vi.mocked(getSessionDetailContent).mockRejectedValueOnce({
      code: "SESSION_NOT_FOUND",
      message: `Captured session ${detail.id} was not found.`,
    });

    const result = await ensureSessionDetailContent(queryClient, detail.id, {
      includeRawResponse: true,
      includeResponseBodyText: true,
    });

    expect(result.id).toBe(detail.id);
    expect(result.rawResponseDeferred).toBeUndefined();
    expect(result.responseBody?.textDeferred).toBeUndefined();
    expect(queryClient.getQueryData([SESSION_DETAIL_QUERY_KEY, detail.id])).toMatchObject(result);
  });
});

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "b46162e2-658c-404f-a3c8-714f093d6b12",
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    summary: {
      durationMs: 42,
      finishedAt: "2026-06-01T00:00:00.000Z",
      host: "api.example.com",
      id: "b46162e2-658c-404f-a3c8-714f093d6b12",
      method: "GET",
      path: "/v1/test",
      protocol: "https",
      sizeBytes: 15,
      startedAt: "2026-06-01T00:00:00.000Z",
      statusCode: 200,
      url: "https://api.example.com/v1/test",
    },
    ...overrides,
  };
}
