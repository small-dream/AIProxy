import { describe, expect, it } from "vitest";

import { resolveDecodedBodyView } from "./decoded-body.helpers";

describe("resolveDecodedBodyView", () => {
  it("parses JSON results for the tree and pretty-prints them for the text view", () => {
    expect(
      resolveDecodedBodyView({
        kind: "json",
        sizeBytes: 22,
        text: '{"tabId":9,"plays":[]}',
        truncated: false,
      }),
    ).toEqual({
      language: "json",
      text: '{\n    "tabId": 9,\n    "plays": []\n}',
      treeAvailable: true,
      value: { plays: [], tabId: 9 },
    });
  });

  it("treats text results that hold a JSON document as JSON", () => {
    const view = resolveDecodedBodyView({
      kind: "text",
      sizeBytes: 8,
      text: '{"a":1}',
      truncated: false,
    });
    expect(view.language).toBe("json");
  });

  it("keeps 64-bit integers exact in the text view", () => {
    const view = resolveDecodedBodyView({
      kind: "text",
      sizeBytes: 30,
      text: '{"id":1234567890123456789}',
      truncated: false,
    });
    expect(view.text).toBe('{\n    "id": 1234567890123456789\n}');
  });

  it("keeps other text results as plain text", () => {
    expect(
      resolveDecodedBodyView({ kind: "text", sizeBytes: 5, text: "hello", truncated: false }),
    ).toEqual({ language: "plain", text: "hello" });
    expect(
      resolveDecodedBodyView({ kind: "text", sizeBytes: 2, text: "42", truncated: false }),
    ).toEqual({ language: "plain", text: "42" });
  });

  it("shows truncated results verbatim because their JSON is incomplete", () => {
    expect(
      resolveDecodedBodyView({
        kind: "json",
        sizeBytes: 9_000_000,
        text: '{"tabId":9,"pl',
        truncated: true,
      }),
    ).toEqual({ language: "plain", text: '{"tabId":9,"pl' });
  });

  it("disables the tree for JSON too large to render as a tree", () => {
    const text = JSON.stringify({ blob: "x".repeat(3 * 1024 * 1024) });
    const view = resolveDecodedBodyView({
      kind: "json",
      sizeBytes: text.length,
      text,
      truncated: false,
    });
    expect(view).toMatchObject({ language: "json", treeAvailable: false });
  });
});
