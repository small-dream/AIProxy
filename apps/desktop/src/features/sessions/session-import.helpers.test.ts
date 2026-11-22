import { describe, expect, it, vi } from "vitest";

import { HarImportError, parseHarArchive } from "./session-import.helpers";

/** Capture the thrown error so tests can assert on its structured kind. */
function captureImportError(contents: string): HarImportError {
  try {
    parseHarArchive(contents);
  } catch (error) {
    expect(error).toBeInstanceOf(HarImportError);
    return error as HarImportError;
  }
  throw new Error("expected parseHarArchive to throw");
}

describe("parseHarArchive", () => {
  it("maps HAR entries into session details", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
      "11111111-1111-1111-1111-111111111111",
    );

    const details = parseHarArchive(
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                headers: [{ name: "content-type", value: "application/json" }],
                method: "POST",
                postData: {
                  mimeType: "application/json",
                  text: '{"hello":"world"}',
                },
                queryString: [{ name: "page", value: "1" }],
                url: "https://example.com/api/test?page=1",
              },
              response: {
                content: {
                  mimeType: "application/json",
                  size: 17,
                  text: '{"ok":true}',
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
      }),
    );

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      id: "imported-har-11111111-1111-1111-1111-111111111111",
      queryParams: [{ name: "page", value: "1" }],
      requestBody: {
        inlineText: '{"hello":"world"}',
        mimeType: "application/json",
      },
      responseBody: {
        inlineText: '{"ok":true}',
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
    const error = captureImportError(JSON.stringify({ log: { entries: [] } }));
    expect(error.kind).toBe("noEntries");
  });

  it("classifies non-JSON and non-HAR inputs by kind", () => {
    // M-9: parse failures are structured so the UI can localize them —
    // never asserted as hardcoded English strings again.
    expect(captureImportError("{not json").kind).toBe("invalidJson");
    expect(captureImportError(JSON.stringify({ no: "log" })).kind).toBe("invalidHar");
  });

  it("names the offending entry kind when a request URL is invalid", () => {
    const error = captureImportError(
      JSON.stringify({
        log: {
          entries: [
            {
              request: { headers: [], method: "GET", url: "not a url" },
              response: { content: {}, headers: [], status: 200 },
            },
          ],
        },
      }),
    );
    expect(error.kind).toBe("invalidUrl");
    expect(error.entryIndex).toBe(0);
  });

  it("names the offending entry kind when a request has no method or URL", () => {
    const error = captureImportError(
      JSON.stringify({
        log: {
          entries: [{ request: { headers: [] } }],
        },
      }),
    );
    expect(error.kind).toBe("invalidEntry");
    expect(error.entryIndex).toBe(0);
  });

  // P3: `text.length` counts UTF-16 code units, not bytes, so CJK bodies were
  // under-counted and base64 bodies over-counted by ~1.37x in the list, the
  // inspector and any re-export.
  it("measures a text body in UTF-8 bytes", () => {
    const details = parseHarArchive(
      JSON.stringify({
        log: {
          entries: [
            {
              request: { headers: [], method: "GET", url: "https://example.com/api" },
              response: {
                content: { mimeType: "text/plain", text: "中文" },
                headers: [],
                status: 200,
              },
            },
          ],
        },
      }),
    );

    // Two CJK characters = 6 UTF-8 bytes (not 2).
    expect(details[0]?.responseBody?.sizeBytes).toBe(6);
  });

  it("measures a base64 body by its decoded byte length", () => {
    const details = parseHarArchive(
      JSON.stringify({
        log: {
          entries: [
            {
              request: { headers: [], method: "GET", url: "https://example.com/api" },
              response: {
                content: {
                  encoding: "base64",
                  mimeType: "image/png",
                  // btoa("hello") = "aGVsbG8=" → 5 decoded bytes, 8 characters.
                  size: 5,
                  text: "aGVsbG8=",
                },
                headers: [],
                status: 200,
              },
            },
          ],
        },
      }),
    );

    expect(details[0]?.responseBody?.sizeBytes).toBe(5);
    expect(details[0]?.responseBody?.base64Text).toBe("aGVsbG8=");
  });

  it("ignores line wrapping in a base64 body when counting bytes", () => {
    const details = parseHarArchive(
      JSON.stringify({
        log: {
          entries: [
            {
              request: { headers: [], method: "GET", url: "https://example.com/api" },
              response: {
                content: {
                  encoding: "base64",
                  mimeType: "image/png",
                  // Same 5-byte payload, wrapped at 4 columns.
                  text: "aGVs\nbG8=",
                },
                headers: [],
                status: 200,
              },
            },
          ],
        },
      }),
    );

    expect(details[0]?.responseBody?.sizeBytes).toBe(5);
  });

  // P3: a bare `Invalid URL` from `new URL` aborted the whole import with no
  // hint about which record was broken. The kind + entryIndex above carry
  // that hint through the localized UI message.

  it("parses HTTP/2 version from HAR entry", () => {
    const details = parseHarArchive(
      JSON.stringify({
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
      }),
    );

    expect(details).toHaveLength(1);
    expect(details[0]!.summary.httpVersion).toBe("2");
  });
});
