import { describe, expect, it } from "vitest";
import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { buildComposeLoadInput } from "./session-compose.helpers";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-05-09T10:00:00.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "POST",
    path: "/submit",
    protocol: "https",
    sizeBytes: 128,
    startedAt: "2026-05-09T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/submit",
    ...overrides,
  };
}

function createSessionDetail(requestBody: BodyReference): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [],
    requestBody,
    requestHeaders: [{ name: "content-type", value: requestBody.mimeType ?? "" }],
    responseHeaders: [],
    summary: createSessionSummary(),
  };
}

describe("buildComposeLoadInput", () => {
  it("keeps urlencoded request bodies as structured compose form entries", () => {
    const input = buildComposeLoadInput(
      createSessionSummary(),
      createSessionDetail({
        inlineText: "_sessionKey=50%3A386&first_launch=0&experiment_names=%5B%22a%22%2C%22b%22%5D",
        mimeType: "application/x-www-form-urlencoded",
        sizeBytes: 78,
      }),
    );

    expect(input.bodyType).toBe("urlencoded");
    expect(input.urlEncodedEntries).toEqual([
      { name: "_sessionKey", value: "50:386" },
      { name: "first_launch", value: "0" },
      { name: "experiment_names", value: '["a","b"]' },
    ]);
  });

  it("keeps multipart text fields as structured compose form entries", () => {
    const input = buildComposeLoadInput(
      createSessionSummary(),
      createSessionDetail({
        inlineText:
          "--boundary\r\n" +
          'Content-Disposition: form-data; name="email"\r\n\r\n' +
          "user@example.com\r\n" +
          "--boundary--\r\n",
        mimeType: "multipart/form-data; boundary=boundary",
        sizeBytes: 93,
      }),
    );

    expect(input.bodyType).toBe("formdata");
    expect(input.formDataEntries).toEqual([{ name: "email", value: "user@example.com" }]);
  });

  it("falls back to raw text when multipart fields cannot be represented by the compose form editor", () => {
    const input = buildComposeLoadInput(
      createSessionSummary(),
      createSessionDetail({
        inlineText:
          "--boundary\r\n" +
          'Content-Disposition: form-data; name="upload"; filename="payload.bin"\r\n' +
          "Content-Type: application/octet-stream\r\n\r\n" +
          "abc\r\n" +
          "--boundary--\r\n",
        mimeType: "multipart/form-data; boundary=boundary",
        sizeBytes: 132,
      }),
    );

    expect(input.bodyType).toBe("raw");
    expect(input.rawLanguage).toBe("text");
  });
});
