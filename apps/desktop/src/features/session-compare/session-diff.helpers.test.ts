import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { buildSessionDiffPayload } from "./session-diff.helpers";

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

describe("buildSessionDiffPayload", () => {
  it("diffs headers case-insensitively", () => {
    const payload = buildSessionDiffPayload(
      detail({
        requestHeaders: [{ name: "Authorization", value: "Bearer left" }],
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestHeaders: [{ name: "authorization", value: "Bearer right" }],
      }),
      { includeBodyForAi: true, redact: false },
    );

    const headers = payload.sections.find((section) => section.key === "requestHeaders");

    expect(headers?.changed).toBe(1);
    expect(headers?.entries[0]).toMatchObject({
      path: "authorization",
      before: "Bearer left",
      after: "Bearer right",
    });
  });

  it("diffs JSON bodies by path", () => {
    const payload = buildSessionDiffPayload(
      detail({
        requestBody: {
          inlineText: JSON.stringify({ user: { id: 1, name: "Ada" } }),
          sizeBytes: 30,
        },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestBody: {
          inlineText: JSON.stringify({ user: { id: 1, name: "Grace" }, debug: true }),
          sizeBytes: 50,
        },
      }),
      { includeBodyForAi: true, redact: false },
    );

    const body = payload.sections.find((section) => section.key === "requestBody");

    expect(body?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.debug", kind: "added" }),
        expect.objectContaining({ path: "$.user.name", kind: "changed" }),
      ]),
    );
  });

  it("redacts sensitive fields before AI", () => {
    const payload = buildSessionDiffPayload(
      detail({
        requestHeaders: [{ name: "Cookie", value: "token=left" }],
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestHeaders: [{ name: "Cookie", value: "token=right" }],
      }),
      { includeBodyForAi: true, redact: true },
    );

    const headers = payload.sections.find((section) => section.key === "requestHeaders");

    expect(payload.redacted).toBe(true);
    expect(headers?.entries[0]).toMatchObject({
      before: "[REDACTED]",
      after: "[REDACTED]",
    });
  });

  it("keeps body text out of the AI payload when disabled", () => {
    const payload = buildSessionDiffPayload(
      detail({
        responseBody: { inlineText: "left secret body", sizeBytes: 16 },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        responseBody: { inlineText: "right secret body", sizeBytes: 17 },
      }),
      { includeBodyForAi: false, redact: true },
    );

    const body = payload.sections.find((section) => section.key === "responseBody");

    expect(payload.bodyIncluded).toBe(false);
    expect(body?.note).toContain("excluded");
    expect(JSON.stringify(body)).not.toContain("secret body");
  });
});
