import { describe, expect, it, vi } from "vitest";

import { parseHarArchive } from "./session-import.helpers";

describe("parseHarArchive", () => {
  it("maps HAR entries into session details", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-1111-1111-111111111111");

    const details = parseHarArchive(JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [{ name: "content-type", value: "application/json" }],
              method: "POST",
              postData: {
                mimeType: "application/json",
                text: "{\"hello\":\"world\"}",
              },
              queryString: [{ name: "page", value: "1" }],
              url: "https://example.com/api/test?page=1",
            },
            response: {
              content: {
                mimeType: "application/json",
                size: 17,
                text: "{\"ok\":true}",
              },
              headers: [{ name: "cache-control", value: "no-cache" }],
              status: 201,
            },
            startedDateTime: "2026-04-21T10:00:00.000Z",
            time: 120,
            timings: {
              connect: 20,
              dns: 10,
              receive: 30,
              send: 5,
              ssl: 15,
              wait: 40,
            },
          },
        ],
      },
    }));

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      id: "imported-har-11111111-1111-1111-1111-111111111111",
      queryParams: [{ name: "page", value: "1" }],
      requestBody: {
        inlineText: "{\"hello\":\"world\"}",
        mimeType: "application/json",
      },
      responseBody: {
        inlineText: "{\"ok\":true}",
        mimeType: "application/json",
      },
      responseHeaders: [{ name: "cache-control", value: "no-cache" }],
      summary: {
        durationMs: 120,
        host: "example.com",
        id: "imported-har-11111111-1111-1111-1111-111111111111",
        method: "POST",
        path: "/api/test?page=1",
        protocol: "https",
        responseMimeType: "application/json",
        startedAt: "2026-04-21T10:00:00.000Z",
        statusCode: 201,
        url: "https://example.com/api/test?page=1",
      },
      timing: {
        connectMs: 20,
        dnsMs: 10,
        requestSendMs: 5,
        responseReadMs: 30,
        tlsMs: 15,
        totalMs: 120,
        waitingMs: 40,
      },
    });
  });

  it("rejects files without HAR entries", () => {
    expect(() => parseHarArchive(JSON.stringify({ log: { entries: [] } }))).toThrow(
      "does not contain any entries",
    );
  });

  it("parses HTTP/2 version from HAR entry", () => {
    const details = parseHarArchive(JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [],
              httpVersion: "HTTP/2",
              method: "GET",
              url: "https://example.com/api",
            },
            response: {
              content: {},
              headers: [],
              status: 200,
            },
            startedDateTime: new Date().toISOString(),
            time: 100,
            timings: { send: 10, wait: 50, receive: 40 },
          },
        ],
      },
    }));

    expect(details).toHaveLength(1);
    expect(details[0]!.summary.httpVersion).toBe("2");
  });
});
