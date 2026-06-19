import { describe, expect, it } from "vitest";
import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import {
  clampInspectorSplitRatio,
  clampNumber,
  findNormalizedMatchIndex,
  formatJsonText,
  getBodyCodeLanguage,
  getJsonChildren,
  getRequestOperationLabel,
  hasPreviewableMediaMimeType,
  parseFormEntries,
  parseJsonBody,
  resolveResponseEmptyStateMessage,
  serializeJsonNode,
} from "./session-inspector.helpers";

function createBodyReference(overrides: Partial<BodyReference> = {}): BodyReference {
  return {
    inlineText: '{"ok":true}',
    mimeType: "application/json",
    sizeBytes: 12,
    ...overrides,
  };
}

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 165,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "POST",
    path: "/api",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/api",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [],
    summary: createSessionSummary(),
    ...overrides,
  };
}

describe("parseJsonBody", () => {
  it("parses valid JSON without eagerly formatting text", () => {
    const result = parseJsonBody(createBodyReference(), '{"ok":true}');

    expect(result).toEqual({
      status: "success",
      value: { ok: true },
    });
  });

  it("returns tooLarge when the body exceeds the tree threshold", () => {
    const result = parseJsonBody(
      createBodyReference({ sizeBytes: 2 * 1024 * 1024 + 1 }),
      '{"ok":true}',
    );

    expect(result).toEqual({
      message:
        "JSON body is too large for tree rendering right now. Use JSON Text or Raw to inspect the payload.",
      status: "tooLarge",
    });
  });

  it("returns truncated error when the body was truncated during capture", () => {
    const result = parseJsonBody(
      createBodyReference({ truncated: true, sizeBytes: 200 * 1024 }),
      '{"ok":true,"items":[1,2,3',
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("truncated");
    }
  });

  it("returns truncated error with custom truncatedMessage", () => {
    const result = parseJsonBody(
      createBodyReference({ truncated: true, sizeBytes: 200 * 1024 }),
      '{"ok":true,"items":[1,2,3',
      { truncatedMessage: "custom truncated" },
    );

    expect(result).toEqual({
      message: "custom truncated",
      status: "error",
    });
  });

  it("returns the request fallback message when parsing fails and raw text fallback is allowed", () => {
    const result = parseJsonBody(
      createBodyReference({ inlineText: "{invalid", sizeBytes: 8 }),
      "{invalid",
      {
        allowLargeTextFallback: true,
        requestFallbackMessage: "show raw",
      },
    );

    expect(result).toEqual({
      message: "show raw",
      status: "error",
    });
  });
});

describe("parseFormEntries", () => {
  it("parses multipart file parts from base64 without rendering binary payload as text", () => {
    const encoder = new TextEncoder();
    const head = encoder.encode(
      "--boundary\r\n" +
        'Content-Disposition: form-data; name="email"\r\n\r\n' +
        "user@example.com\r\n" +
        "--boundary\r\n" +
        'Content-Disposition: form-data; name="Filedata"; filename="submit.gz"\r\n' +
        "Content-Type: application/gzip\r\n\r\n",
    );
    const fileBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const tail = encoder.encode("\r\n--boundary--\r\n");
    const payloadBytes = new Uint8Array(head.length + fileBytes.length + tail.length);

    payloadBytes.set(head, 0);
    payloadBytes.set(fileBytes, head.length);
    payloadBytes.set(tail, head.length + fileBytes.length);

    expect(
      parseFormEntries({
        base64Text: Buffer.from(payloadBytes).toString("base64"),
        mimeType: "multipart/form-data",
        sizeBytes: payloadBytes.length,
      }),
    ).toEqual([
      {
        contentType: "text/plain; charset=utf-8",
        kind: "field",
        name: "email",
        value: "user@example.com",
      },
      {
        contentType: "application/gzip",
        filename: "submit.gz",
        kind: "file",
        name: "Filedata",
        sizeBytes: 4,
      },
    ]);
  });
});

describe("formatJsonText", () => {
  it("pretty prints JSON values on demand", () => {
    expect(formatJsonText({ ok: true, items: [1, 2] })).toBe(
      '{\n    "ok": true,\n    "items": [\n        1,\n        2\n    ]\n}',
    );
  });
});

describe("getBodyCodeLanguage", () => {
  it("detects JSON bodies from content type", () => {
    expect(getBodyCodeLanguage(createBodyReference(), '{"ok":true}')).toBe("json");
  });

  it("detects JSON bodies from visible text when content type is missing", () => {
    const body = createBodyReference();

    delete body.mimeType;

    expect(getBodyCodeLanguage(body, "[1,2,3]")).toBe("json");
  });

  it("uses plain text for non-JSON bodies", () => {
    expect(getBodyCodeLanguage(createBodyReference({ mimeType: "text/plain" }), "hello")).toBe(
      "plain",
    );
  });
});

describe("findNormalizedMatchIndex", () => {
  it("matches case-insensitively", () => {
    expect(findNormalizedMatchIndex("UserID", "userid")).toBe(0);
  });
});

describe("clampInspectorSplitRatio", () => {
  it("keeps the ratio within the supported drag bounds", () => {
    expect(clampInspectorSplitRatio(0.05)).toBe(0.15);
    expect(clampInspectorSplitRatio(0.45)).toBe(0.45);
    expect(clampInspectorSplitRatio(0.95)).toBe(0.85);
  });
});

describe("getRequestOperationLabel", () => {
  it("prefers explicit query params like _method", () => {
    const detail = createSessionDetail({
      queryParams: [
        { name: "_app", value: "Android" },
        { name: "_method", value: "app.launch" },
      ],
    });

    expect(getRequestOperationLabel(detail, createSessionSummary())).toBe("app.launch");
  });

  it("reads operation params from the summary URL before detail loads", () => {
    const session = createSessionSummary({
      path: "/api/events?__method=track_events",
      url: "https://api.example.com/api/events?__method=track_events",
    });

    expect(getRequestOperationLabel(undefined, session)).toBe("track_events");
  });

  it("supports keyed path segments when the method is embedded in the path", () => {
    const session = createSessionSummary({
      path: "/rpc/method/app.launch",
      url: "https://api.example.com/rpc/method/app.launch",
    });

    expect(getRequestOperationLabel(undefined, session)).toBe("app.launch");
  });

  it("falls back to explicit dotted path segments", () => {
    const session = createSessionSummary({
      path: "/api/app.launch",
      url: "https://api.example.com/api/app.launch",
    });

    expect(getRequestOperationLabel(undefined, session)).toBe("app.launch");
  });

  it("does not treat generic rest segments as an operation label", () => {
    const session = createSessionSummary({
      path: "/api/users/list",
      url: "https://api.example.com/api/users/list",
    });

    expect(getRequestOperationLabel(undefined, session)).toBeUndefined();
  });
});

describe("clampNumber", () => {
  it("clamps values below the minimum", () => {
    expect(clampNumber(0.05, 0.16, 0.5)).toBe(0.16);
  });

  it("clamps values above the maximum", () => {
    expect(clampNumber(0.95, 0.1, 0.8)).toBe(0.8);
  });

  it("keeps values within the range unchanged", () => {
    expect(clampNumber(0.33, 0.16, 0.5)).toBe(0.33);
  });

  it("returns the minimum when min equals max", () => {
    expect(clampNumber(0.7, 0.3, 0.3)).toBe(0.3);
  });

  it("handles negative ranges", () => {
    expect(clampNumber(-5, -10, 10)).toBe(-5);
  });
});

describe("serializeJsonNode", () => {
  it("pretty-prints an object", () => {
    expect(serializeJsonNode({ name: "Alice", age: 30 })).toBe(
      '{\n    "name": "Alice",\n    "age": 30\n}',
    );
  });

  it("pretty-prints an array", () => {
    expect(serializeJsonNode([1, 2, 3])).toBe("[\n    1,\n    2,\n    3\n]");
  });

  it("returns a string value without wrapping quotes", () => {
    expect(serializeJsonNode("hello world")).toBe("hello world");
  });

  it("returns the JSON representation of null", () => {
    expect(serializeJsonNode(null)).toBe("null");
  });

  it("returns the JSON representation of a number", () => {
    expect(serializeJsonNode(42)).toBe("42");
  });

  it("returns the JSON representation of a boolean", () => {
    expect(serializeJsonNode(true)).toBe("true");
    expect(serializeJsonNode(false)).toBe("false");
  });

  it("pretty-prints nested structure", () => {
    const result = serializeJsonNode({ items: [{ id: 1 }, { id: 2 }] });
    expect(result).toBe(
      '{\n    "items": [\n        {\n            "id": 1\n        },\n        {\n            "id": 2\n        }\n    ]\n}',
    );
  });
});

describe("getJsonChildren", () => {
  it("returns entries for an object", () => {
    expect(getJsonChildren({ a: 1, b: 2 })).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("returns indexed entries for an array", () => {
    expect(getJsonChildren([true, false])).toEqual([
      ["[0]", true],
      ["[1]", false],
    ]);
  });

  it("returns an empty array for primitives", () => {
    expect(getJsonChildren("text")).toEqual([]);
    expect(getJsonChildren(123)).toEqual([]);
    expect(getJsonChildren(null)).toEqual([]);
    expect(getJsonChildren(true)).toEqual([]);
  });

  it("returns an empty array for an empty object", () => {
    expect(getJsonChildren({})).toEqual([]);
  });

  it("returns an empty array for an empty array", () => {
    expect(getJsonChildren([])).toEqual([]);
  });
});

describe("hasPreviewableMediaMimeType", () => {
  it("returns true for common image types", () => {
    expect(hasPreviewableMediaMimeType("image/png")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/jpeg")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/gif")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/webp")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/svg+xml")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/bmp")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/x-icon")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/tiff")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/avif")).toBe(true);
    expect(hasPreviewableMediaMimeType("image/apng")).toBe(true);
  });

  it("returns true for audio and video types", () => {
    expect(hasPreviewableMediaMimeType("audio/mpeg")).toBe(true);
    expect(hasPreviewableMediaMimeType("audio/wav")).toBe(true);
    expect(hasPreviewableMediaMimeType("audio/ogg")).toBe(true);
    expect(hasPreviewableMediaMimeType("video/mp4")).toBe(true);
    expect(hasPreviewableMediaMimeType("video/webm")).toBe(true);
  });

  it("returns true regardless of case", () => {
    expect(hasPreviewableMediaMimeType("Image/PNG")).toBe(true);
    expect(hasPreviewableMediaMimeType("IMAGE/JPEG")).toBe(true);
    expect(hasPreviewableMediaMimeType("Audio/MPEG")).toBe(true);
  });

  it("returns false for non-media types", () => {
    expect(hasPreviewableMediaMimeType("application/json")).toBe(false);
    expect(hasPreviewableMediaMimeType("text/plain")).toBe(false);
    expect(hasPreviewableMediaMimeType("application/octet-stream")).toBe(false);
    expect(hasPreviewableMediaMimeType("font/woff2")).toBe(false);
    expect(hasPreviewableMediaMimeType("application/pdf")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasPreviewableMediaMimeType(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasPreviewableMediaMimeType("")).toBe(false);
  });
});

describe("resolveResponseEmptyStateMessage", () => {
  const messages = {
    noJsonBody: "NO_JSON_BODY",
    emptyBodyReceived: "EMPTY_BODY_RECEIVED",
  };

  it("attributes an empty body to the server when no body was captured", () => {
    expect(resolveResponseEmptyStateMessage({ status: "idle" }, false, messages)).toBe(
      "EMPTY_BODY_RECEIVED",
    );
  });

  it("falls back to the generic copy when a non-JSON body is present", () => {
    expect(resolveResponseEmptyStateMessage({ status: "idle" }, true, messages)).toBe(
      "NO_JSON_BODY",
    );
  });

  it("uses the generic copy for parse errors even with no body", () => {
    expect(
      resolveResponseEmptyStateMessage({ status: "error", message: "boom" }, false, messages),
    ).toBe("NO_JSON_BODY");
  });

  it("uses the generic copy for too-large bodies", () => {
    expect(
      resolveResponseEmptyStateMessage({ status: "tooLarge", message: "big" }, false, messages),
    ).toBe("NO_JSON_BODY");
  });
});
