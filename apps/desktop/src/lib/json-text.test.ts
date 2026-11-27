import { describe, expect, it } from "vitest";

import { parseJsonText, reindentJsonText, stringifyJsonValue } from "./json-text";

describe("reindentJsonText", () => {
  it("matches JSON.stringify at the requested indent while keeping exact digits", () => {
    const source = '{"a":[1,{"b":"\\u4e2d"}],"e":{},"f":[]}';
    expect(reindentJsonText(source, 2)).toBe(JSON.stringify(JSON.parse(source), null, 2));
    expect(reindentJsonText('{"id":1234567890123456789}', 2)).toBe(
      '{\n  "id": 1234567890123456789\n}',
    );
  });
});

describe("stringifyJsonValue", () => {
  it("writes compact JSON with bigint values as plain integers", () => {
    expect(stringifyJsonValue({ id: 1234567890123456789n, list: [1, "a", null] })).toBe(
      '{"id":1234567890123456789,"list":[1,"a",null]}',
    );
  });

  it("round-trips parseJsonText output", () => {
    const source = '{"id":1234567890123456789,"s":"x","n":[1.5,-9007199254740993]}';
    expect(stringifyJsonValue(parseJsonText(source))).toBe(source);
  });
});
