import { describe, expect, it } from "vitest";
import type { BodyReference } from "@pharles/shared-types";

import { formatJsonText, parseJsonBody } from "./session-inspector.helpers";

function createBodyReference(overrides: Partial<BodyReference> = {}): BodyReference {
  return {
    inlineText: "{\"ok\":true}",
    mimeType: "application/json",
    sizeBytes: 12,
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

describe("formatJsonText", () => {
  it("pretty prints JSON values on demand", () => {
    expect(formatJsonText({ ok: true, items: [1, 2] })).toBe('{\n    "ok": true,\n    "items": [\n        1,\n        2\n    ]\n}');
  });
});
