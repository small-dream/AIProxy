import { describe, expect, it } from "vitest";

import { formatTracePayload, shouldCollapseTracePayload } from "./trace-payload.helpers";

describe("formatTracePayload", () => {
  it("pretty-prints JSON objects and arrays like the JSON text tab", () => {
    expect(formatTracePayload('{"tabId":9,"plays":[1,2]}')).toEqual({
      language: "json",
      text: '{\n    "tabId": 9,\n    "plays": [\n        1,\n        2\n    ]\n}',
    });
  });

  it("shows a JSON string payload as its plain content", () => {
    expect(formatTracePayload('"line one\\nline two"')).toEqual({
      language: "plain",
      text: "line one\nline two",
    });
  });

  it("pretty-prints a string payload that holds a JSON document", () => {
    expect(formatTracePayload(JSON.stringify('{"ok":true}'))).toEqual({
      language: "json",
      text: '{\n    "ok": true\n}',
    });
  });

  it("keeps scalars as JSON", () => {
    expect(formatTracePayload("42")).toEqual({ language: "json", text: "42" });
    expect(formatTracePayload("null")).toEqual({ language: "json", text: "null" });
  });

  it("keeps unparseable payloads verbatim, such as values cut at the size limit", () => {
    const truncated = '{"tabId":9,"name":"abc...';
    expect(formatTracePayload(truncated)).toEqual({ language: "plain", text: truncated });
    expect(formatTracePayload("[unserializable]")).toEqual({
      language: "plain",
      text: "[unserializable]",
    });
  });
});

describe("formatTracePayload precision and raw values", () => {
  it("keeps 64-bit integers exact when pretty-printing", () => {
    expect(formatTracePayload('{"id":1234567890123456789}').text).toBe(
      '{\n    "id": 1234567890123456789\n}',
    );
    expect(formatTracePayload(JSON.stringify('{"id":1234567890123456789}')).text).toBe(
      '{\n    "id": 1234567890123456789\n}',
    );
  });

  it("shows raw values verbatim, such as quoted header values and rewritten bodies", () => {
    expect(formatTracePayload('"33a64df5"', { raw: true })).toEqual({
      language: "json",
      text: '"33a64df5"',
    });
    expect(formatTracePayload('{"price":1.0}', { raw: true })).toEqual({
      language: "json",
      text: '{"price":1.0}',
    });
    expect(formatTracePayload("BYP5APNO8D/co", { raw: true })).toEqual({
      language: "plain",
      text: "BYP5APNO8D/co",
    });
  });
});

describe("shouldCollapseTracePayload", () => {
  it("leaves short values expanded", () => {
    expect(shouldCollapseTracePayload('{"tabId":9}')).toBe(false);
    expect(shouldCollapseTracePayload("a\nb\nc")).toBe(false);
  });

  it("collapses values with many lines", () => {
    expect(shouldCollapseTracePayload(Array.from({ length: 20 }, (_, i) => i).join("\n"))).toBe(
      true,
    );
  });

  it("collapses long single-line values that wrap into many visual lines", () => {
    expect(shouldCollapseTracePayload("A".repeat(2000))).toBe(true);
  });
});
