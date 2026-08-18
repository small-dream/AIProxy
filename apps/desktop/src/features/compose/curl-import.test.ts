import { describe, expect, it } from "vitest";

import {
  inferRawLanguageFromContentType,
  parseCurlCommand,
  tokenizeCurlCommand,
} from "./curl-import";

describe("tokenizeCurlCommand", () => {
  it("handles POSIX single quotes with '\\'' escapes", () => {
    expect(tokenizeCurlCommand(`curl -H 'x-a: it'\\''s' https://example.com`)).toEqual([
      "curl",
      "-H",
      "x-a: it's",
      "https://example.com",
    ]);
  });

  it('handles Windows double quotes with "" escapes', () => {
    expect(tokenizeCurlCommand(`curl -H "x-a: say ""hi""" https://example.com`)).toEqual([
      "curl",
      "-H",
      'x-a: say "hi"',
      "https://example.com",
    ]);
  });

  it("joins backslash continuations", () => {
    const tokens = tokenizeCurlCommand("curl \\\n  -X POST \\\n  https://example.com");
    expect(tokens).toEqual(["curl", "-X", "POST", "https://example.com"]);
  });
});

describe("parseCurlCommand", () => {
  it("parses method, headers, and JSON body", () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://api.example.com/orders -H 'Content-Type: application/json' -d '{"ok":true}'`,
    );
    expect(parsed).toMatchObject({
      method: "POST",
      url: "https://api.example.com/orders",
      bodyType: "raw",
      body: '{"ok":true}',
    });
    expect(parsed?.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
  });

  it("joins multiple -d arguments with &", () => {
    const parsed = parseCurlCommand(`curl https://example.com -d 'a=1' -d 'b=2'`);
    expect(parsed?.body).toBe("a=1&b=2");
  });

  it("treats --data-raw and --data-binary the same", () => {
    const raw = parseCurlCommand(`curl https://example.com --data-raw '{"x":1}'`);
    expect(raw?.body).toBe('{"x":1}');
    const binary = parseCurlCommand(`curl https://example.com --data-binary 'abc'`);
    expect(binary?.body).toBe("abc");
  });

  it("detects urlencoded from the content-type header", () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://example.com/login -H 'Content-Type: application/x-www-form-urlencoded' -d 'user=alice&pass=secret'`,
    );
    expect(parsed?.bodyType).toBe("urlencoded");
    expect(parsed?.body).toBe("user=alice&pass=secret");
  });

  it("parses -F text fields and file parts with @path", () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://example.com/upload -F 'note=hello' -F 'file=@/tmp/a.txt'`,
    );
    expect(parsed?.bodyType).toBe("formdata");
    expect(parsed?.formDataEntries).toEqual([{ name: "note", value: "hello" }]);
    expect(parsed?.formFiles).toEqual([
      { name: "file", fileName: "a.txt", filePath: "/tmp/a.txt" },
    ]);
  });

  it("handles a Windows-style command", () => {
    const parsed = parseCurlCommand(
      `curl -X PUT "https://example.com/items/1" -H "Content-Type: application/json" -d "{""id"":1}"`,
    );
    expect(parsed?.method).toBe("PUT");
    expect(parsed?.url).toBe("https://example.com/items/1");
    expect(parsed?.body).toBe('{"id":1}');
  });

  it("defaults to GET when no -X is present", () => {
    const parsed = parseCurlCommand(`curl https://example.com`);
    expect(parsed?.method).toBe("GET");
  });

  it("returns null when the URL is missing or not http(s)", () => {
    expect(parseCurlCommand("curl")).toBeNull();
    expect(parseCurlCommand("curl ftp://example.com")).toBeNull();
    expect(parseCurlCommand("wget https://example.com")).toBeNull();
  });
});

describe("inferRawLanguageFromContentType", () => {
  it("maps common content-types to raw languages", () => {
    expect(inferRawLanguageFromContentType("application/json")).toBe("json");
    expect(inferRawLanguageFromContentType("application/problem+json")).toBe("json");
    expect(inferRawLanguageFromContentType("application/xml")).toBe("xml");
    expect(inferRawLanguageFromContentType("text/html")).toBe("html");
    expect(inferRawLanguageFromContentType("text/plain")).toBe("text");
  });
});
