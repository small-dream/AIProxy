import { describe, expect, it } from "vitest";

import { encodeComposedRequest } from "./encode-request";

function input(overrides: Partial<Parameters<typeof encodeComposedRequest>[0]> = {}) {
  return {
    body: "",
    bodyType: "none" as const,
    formDataEntries: [],
    headers: [],
    rawLanguage: "json" as const,
    urlEncodedEntries: [],
    ...overrides,
  };
}

describe("encodeComposedRequest", () => {
  it("returns no body for bodyType none", () => {
    const result = encodeComposedRequest(input());
    expect(result.textBody).toBeUndefined();
    expect(result.multipartEntries).toBeUndefined();
  });

  it("encodes raw bodies and appends the matching Content-Type", () => {
    const result = encodeComposedRequest(
      input({ bodyType: "raw", rawLanguage: "json", body: '{"ok":true}' }),
    );
    expect(result.textBody).toBe('{"ok":true}');
    expect(result.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
  });

  it("does not override an existing Content-Type header", () => {
    const result = encodeComposedRequest(
      input({
        bodyType: "raw",
        rawLanguage: "json",
        body: "x",
        headers: [{ name: "content-type", value: "text/custom" }],
      }),
    );
    expect(result.headers).toEqual([{ name: "content-type", value: "text/custom" }]);
  });

  it("encodes urlencoded entries with URI encoding and filters empty names", () => {
    const result = encodeComposedRequest(
      input({
        bodyType: "urlencoded",
        urlEncodedEntries: [
          { name: "a b", value: "x&y" },
          { name: "  ", value: "ignored" },
        ],
      }),
    );
    expect(result.textBody).toBe("a%20b=x%26y");
    expect(result.headers).toEqual([
      { name: "Content-Type", value: "application/x-www-form-urlencoded" },
    ]);
  });

  it("emits multipart entries and a plain-text body for formdata (3.1 parity)", () => {
    const result = encodeComposedRequest(
      input({
        bodyType: "formdata",
        formDataEntries: [
          { name: "field", value: "value" },
          { name: " ", value: "ignored" },
        ],
      }),
    );
    expect(result.multipartEntries).toHaveLength(1);
    expect(result.multipartEntries?.[0]).toMatchObject({
      kind: "text",
      name: "field",
      value: "value",
    });
    expect(result.textBody).toContain('name="field"');
    expect(result.textBody).toContain("value");
    expect(result.headers[0]?.name).toBe("Content-Type");
    expect(result.headers[0]?.value).toContain("multipart/form-data; boundary=");
  });

  it("substitutes variables across headers, body, and form entries", () => {
    const vars = new Map([
      ["host", "api.example.com"],
      ["token", "secret"],
    ]);
    const result = encodeComposedRequest(
      input({
        bodyType: "raw",
        rawLanguage: "json",
        body: '{"token":"{{token}}"}',
        headers: [{ name: "x-host", value: "{{host}}" }],
      }),
      vars,
    );
    expect(result.textBody).toBe('{"token":"secret"}');
    expect(result.headers).toEqual([
      { name: "x-host", value: "api.example.com" },
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("leaves file paths untouched while substituting the part name", () => {
    const vars = new Map([["dir", "/tmp/aiproxy"]]);
    const result = encodeComposedRequest(
      input({
        bodyType: "formdata",
        formFiles: [{ name: "{{dir}}/upload", fileName: "a.txt", filePath: "/tmp/aiproxy/a.txt" }],
      }),
      vars,
    );
    expect(result.multipartEntries?.[0]).toMatchObject({
      kind: "file",
      name: "/tmp/aiproxy/upload",
      filePath: "/tmp/aiproxy/a.txt",
    });
  });
});
