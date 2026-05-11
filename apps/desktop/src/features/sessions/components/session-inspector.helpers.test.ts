import { describe, expect, it } from "vitest";
import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import {
  clampInspectorSplitRatio,
  findNormalizedMatchIndex,
  formatJsonText,
  getBodyCodeLanguage,
  getRequestOperationLabel,
  parseFormEntries,
  parseJsonBody,
} from "./session-inspector.helpers";

function createBodyReference(overrides: Partial<BodyReference> = {}): BodyReference {
  return {
    inlineText: "{\"ok\":true}",
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
    const result = parseJsonBody(createBodyReference(), "{\"ok\":true}");

    expect(result).toEqual({
      status: "success",
      value: { ok: true },
    });
  });

  it("returns tooLarge when the body exceeds the tree threshold", () => {
    const result = parseJsonBody(
      createBodyReference({ sizeBytes: 2 * 1024 * 1024 + 1 }),
      "{\"ok\":true}",
    );

    expect(result).toEqual({
      message: "JSON body is too large for tree rendering right now. Use JSON Text or Raw to inspect the payload.",
      status: "tooLarge",
    });
  });

  it("returns truncated error when the body was truncated during capture", () => {
    const result = parseJsonBody(
      createBodyReference({ truncated: true, sizeBytes: 200 * 1024 }),
      "{\"ok\":true,\"items\":[1,2,3",
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("truncated");
    }
  });

  it("returns truncated error with custom truncatedMessage", () => {
    const result = parseJsonBody(
      createBodyReference({ truncated: true, sizeBytes: 200 * 1024 }),
      "{\"ok\":true,\"items\":[1,2,3",
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
      "--boundary\r\n"
        + "Content-Disposition: form-data; name=\"email\"\r\n\r\n"
        + "user@example.com\r\n"
        + "--boundary\r\n"
        + "Content-Disposition: form-data; name=\"Filedata\"; filename=\"submit.gz\"\r\n"
        + "Content-Type: application/gzip\r\n\r\n",
    );
    const fileBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const tail = encoder.encode("\r\n--boundary--\r\n");
    const payloadBytes = new Uint8Array(head.length + fileBytes.length + tail.length);

    payloadBytes.set(head, 0);
    payloadBytes.set(fileBytes, head.length);
    payloadBytes.set(tail, head.length + fileBytes.length);

    expect(parseFormEntries({
      base64Text: Buffer.from(payloadBytes).toString("base64"),
      mimeType: "multipart/form-data",
      sizeBytes: payloadBytes.length,
    })).toEqual([
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
    expect(formatJsonText({ ok: true, items: [1, 2] })).toBe('{\n    "ok": true,\n    "items": [\n        1,\n        2\n    ]\n}');
  });
});

describe("getBodyCodeLanguage", () => {
  it("detects JSON bodies from content type", () => {
    expect(getBodyCodeLanguage(createBodyReference(), "{\"ok\":true}")).toBe("json");
  });

  it("detects JSON bodies from visible text when content type is missing", () => {
    const body = createBodyReference();

    delete body.mimeType;

    expect(getBodyCodeLanguage(body, "[1,2,3]")).toBe("json");
  });

  it("uses plain text for non-JSON bodies", () => {
    expect(getBodyCodeLanguage(createBodyReference({ mimeType: "text/plain" }), "hello")).toBe("plain");
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
