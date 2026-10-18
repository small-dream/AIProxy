import { describe, expect, it } from "vitest";

import {
  findJsonTextToken,
  resolveJsonTextLine,
  resolveJsonTextPath,
} from "./json-text-token.helpers";

const SAMPLE = [
  "{",
  '  "userId": 42,',
  '  "profile": {',
  '    "name": "Hello world",',
  '    "active": true,',
  '    "nickname": null',
  "  },",
  '  "tags": ["a", "b"]',
  "}",
].join("\n");

describe("findJsonTextToken", () => {
  it("resolves a key token and keeps the selection inside its quotes", () => {
    const offset = SAMPLE.indexOf("userId") + 2;
    const token = findJsonTextToken(SAMPLE, offset);

    expect(token).toMatchObject({ kind: "key", copyText: "userId", searchText: "userId" });
    expect(SAMPLE.slice(token!.selectStart, token!.selectEnd)).toBe("userId");
  });

  it("resolves a key token when the pointer rests on the colon", () => {
    const token = findJsonTextToken(SAMPLE, SAMPLE.indexOf('"userId"') + '"userId"'.length);

    expect(token?.kind).toBe("key");
    expect(token?.copyText).toBe("userId");
  });

  it("resolves a string value without quotes", () => {
    const offset = SAMPLE.indexOf("Hello world") + 3;
    const token = findJsonTextToken(SAMPLE, offset);

    expect(token).toMatchObject({ kind: "string", copyText: "Hello world" });
    expect(SAMPLE.slice(token!.selectStart, token!.selectEnd)).toBe("Hello world");
  });

  it("resolves numbers, booleans and null to their whole literal", () => {
    expect(findJsonTextToken(SAMPLE, SAMPLE.indexOf("42") + 1)).toMatchObject({
      kind: "number",
      copyText: "42",
    });
    expect(findJsonTextToken(SAMPLE, SAMPLE.indexOf("true") + 1)).toMatchObject({
      kind: "boolean",
      copyText: "true",
    });
    expect(findJsonTextToken(SAMPLE, SAMPLE.indexOf("null") + 1)).toMatchObject({
      kind: "null",
      copyText: "null",
    });
  });

  it("decodes escaped string content for copy but keeps it raw for search", () => {
    const code = '{"path": "a\\nb"}';
    const token = findJsonTextToken(code, code.indexOf("a\\nb"));

    expect(token?.copyText).toBe("a\nb");
    expect(token?.searchText).toBe("a\\nb");
  });

  it("stays on the token when the caret rests right after it", () => {
    const token = findJsonTextToken(SAMPLE, SAMPLE.indexOf("42") + 2);

    expect(token?.copyText).toBe("42");
  });

  it("returns null between tokens", () => {
    expect(findJsonTextToken(SAMPLE, SAMPLE.indexOf('"userId"') - 1)).toBeNull();
  });
});

describe("resolveJsonTextPath", () => {
  it("builds a dot path through objects and arrays", () => {
    const start = SAMPLE.indexOf('"Hello world"');

    expect(resolveJsonTextPath(SAMPLE, start)).toBe("$.profile.name");
  });

  it("indexes array elements", () => {
    const start = SAMPLE.indexOf('"b"');

    expect(resolveJsonTextPath(SAMPLE, start)).toBe("$.tags[1]");
  });

  it("resolves the path of a key token", () => {
    const start = SAMPLE.indexOf('"userId"');

    expect(resolveJsonTextPath(SAMPLE, start)).toBe("$.userId");
  });

  it("brackets keys that are not plain identifiers", () => {
    const code = '{"a.b": 1}';

    expect(resolveJsonTextPath(code, code.indexOf("1"))).toBe('$["a.b"]');
  });

  it("resolves root values and root arrays", () => {
    expect(resolveJsonTextPath("42", 0)).toBe("$");

    const arrayText = "[10, 20]";
    expect(resolveJsonTextPath(arrayText, arrayText.indexOf("20"))).toBe("$[1]");
  });

  it("returns null when the surrounding text is not parseable JSON", () => {
    expect(resolveJsonTextPath('{"a" "b"}', 5)).toBeNull();
  });
});

describe("resolveJsonTextLine", () => {
  it("trims the indentation and trailing comma of the caret line", () => {
    const line = resolveJsonTextLine(SAMPLE, SAMPLE.indexOf("42"));

    expect(line).not.toBeNull();
    expect(SAMPLE.slice(line!.start, line!.end)).toBe('"userId": 42,');
  });

  it("returns null for blank lines", () => {
    expect(resolveJsonTextLine("{\n\n}", 2)).toBeNull();
  });
});
