import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { buildHarArchive, harBodyPayload } from "./session-export.helpers";
import { parseHarArchive } from "./session-import.helpers";

function createSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 12,
    finishedAt: "2026-11-01T00:00:01.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/image.png",
    protocol: "HTTP/1.1",
    responseMimeType: "image/png",
    sizeBytes: 5,
    startedAt: "2026-11-01T00:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/image.png",
    ...overrides,
  };
}

function createDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    summary: createSummary(),
    ...overrides,
  };
}

// P3: binary bodies used to be `atob`-decoded into a Latin-1 string and written
// as plain UTF-8 text, so images/fonts were corrupted on export. HAR supports
// `encoding: "base64"` for exactly this case.
describe("buildHarArchive body encoding", () => {
  it("exports a binary response as base64 with the encoding marker", () => {
    const archive = buildHarArchive([
      createDetail({
        responseBody: {
          base64Text: "aGVsbG8=",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      }),
    ]);

    const content = archive.log.entries[0]?.response.content;
    expect(content).toMatchObject({ encoding: "base64", text: "aGVsbG8=", size: 5 });
  });

  it("keeps text bodies readable and does not mark them as base64", () => {
    const archive = buildHarArchive([
      createDetail({
        responseBody: { inlineText: "hi", mimeType: "text/plain", sizeBytes: 2 },
      }),
    ]);

    const content = archive.log.entries[0]?.response.content;
    expect(content).not.toHaveProperty("encoding");
    expect(content?.text).toBe("hi");
  });

  it("encodes a base64 request body in postData too", () => {
    const archive = buildHarArchive([
      createDetail({
        requestBody: { base64Text: "/w==", mimeType: "application/octet-stream", sizeBytes: 1 },
      }),
    ]);

    expect(archive.log.entries[0]?.request.postData).toMatchObject({
      encoding: "base64",
      text: "/w==",
    });
  });

  it("round-trips a binary body through the app's own HAR importer", () => {
    const base64Text = Buffer.from([0x00, 0xff, 0x10, 0x80]).toString("base64");
    const archive = buildHarArchive([
      createDetail({
        responseBody: { base64Text, mimeType: "application/octet-stream", sizeBytes: 4 },
      }),
    ]);

    const imported = parseHarArchive(JSON.stringify(archive));
    expect(imported[0]?.responseBody).toMatchObject({ base64Text, sizeBytes: 4 });
  });

  it("returns an empty text body when the body reference is missing", () => {
    expect(harBodyPayload(undefined)).toEqual({ text: "" });
  });
});
