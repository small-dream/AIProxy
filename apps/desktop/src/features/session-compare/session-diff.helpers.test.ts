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

  it("keeps body diff lazy when summary mode is used", () => {
    const payload = buildSessionDiffPayload(
      detail({
        requestBody: { inlineText: JSON.stringify({ name: "Ada" }), sizeBytes: 14 },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestBody: { inlineText: JSON.stringify({ name: "Grace" }), sizeBytes: 16 },
      }),
      { bodyDiffMode: "summary", includeBodyForAi: true, redact: false },
    );

    const body = payload.sections.find((section) => section.key === "requestBody");

    expect(body?.canExpand).toBe(true);
    expect(body?.note).toContain("collapsed");
    expect(JSON.stringify(body)).not.toContain("$.name");
  });

  it("reports binary body state explicitly", () => {
    const payload = buildSessionDiffPayload(
      detail({
        responseBody: { mimeType: "application/octet-stream", sizeBytes: 12 },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        responseBody: { mimeType: "application/octet-stream", sizeBytes: 16 },
      }),
      { includeBodyForAi: true, redact: false },
    );

    const body = payload.sections.find((section) => section.key === "responseBody");

    expect(body?.note).toContain("not available as renderable text");
    expect(body?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "body.text",
          before: "Non-text or binary",
          after: "Non-text or binary",
        }),
      ]),
    );
  });

  it("guards large body diffs before parsing detailed entries", () => {
    const largeBody = "a".repeat(300_000);
    const payload = buildSessionDiffPayload(
      detail({
        requestBody: { inlineText: largeBody, sizeBytes: largeBody.length },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestBody: { inlineText: `${largeBody}b`, sizeBytes: largeBody.length + 1 },
      }),
      { includeBodyForAi: true, redact: false },
    );

    const body = payload.sections.find((section) => section.key === "requestBody");

    expect(body?.truncated).toBe(true);
    expect(body?.truncationReason).toContain("size guard");
    expect(body?.entries.some((entry) => entry.path.startsWith("line "))).toBe(false);
  });

  it("marks bounded body entries as truncated", () => {
    const leftBody = Array.from({ length: 5 }, (_, index) => `left-${index}`).join("\n");
    const rightBody = Array.from({ length: 5 }, (_, index) => `right-${index}`).join("\n");
    const payload = buildSessionDiffPayload(
      detail({
        requestBody: { inlineText: leftBody, sizeBytes: leftBody.length },
      }),
      detail({
        summary: summary({ id: "session-2" }),
        requestBody: { inlineText: rightBody, sizeBytes: rightBody.length },
      }),
      { includeBodyForAi: true, maxBodyEntries: 2, redact: false },
    );

    const body = payload.sections.find((section) => section.key === "requestBody");

    expect(body?.entries).toHaveLength(2);
    expect(body?.totalEntries).toBe(5);
    expect(body?.truncated).toBe(true);
  });
});
