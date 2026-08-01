import { describe, expect, it } from "vitest";

import { generateCurlCommand } from "./curl-export";

describe("generateCurlCommand", () => {
  const baseParams = {
    method: "POST",
    url: "https://example.com/api?q=hello",
    headers: [
      { name: "Content-Type", value: "application/json", isPseudo: false },
      { name: "X-Empty", value: "", isPseudo: false },
    ],
    body: '{"hello":"world"}',
  };

  describe("POSIX (macOS / Linux)", () => {
    it("single-quotes arguments and uses backslash line continuation", () => {
      const cmd = generateCurlCommand(baseParams, { platform: "macos" });
      // Continuation joins with ` \\\n  ` and every argument is single-quoted.
      expect(cmd).toContain(" \\\n  ");
      expect(cmd.startsWith("curl")).toBe(true);
      expect(cmd).toContain("-X POST");
      expect(cmd).toContain("-H 'Content-Type: application/json'");
      expect(cmd).toContain("-d '{\"hello\":\"world\"}'");
      expect(cmd.endsWith("'https://example.com/api?q=hello'")).toBe(true);
    });

    it("escapes embedded single quotes with '\\''", () => {
      const cmd = generateCurlCommand(
        {
          method: "GET",
          url: "https://example.com/a",
          headers: [{ name: "X-Token", value: "it's me", isPseudo: false }],
        },
        { platform: "linux" },
      );
      expect(cmd).toContain("-H 'X-Token: it'\\''s me'");
      // GET omits -X.
      expect(cmd).not.toContain("-X GET");
    });

    it("skips headers with a blank name", () => {
      const cmd = generateCurlCommand(
        {
          method: "GET",
          url: "https://example.com/a",
          headers: [
            { name: "", value: "ignored", isPseudo: false },
            { name: "Keep", value: "me", isPseudo: false },
          ],
        },
        { platform: "macos" },
      );
      expect(cmd).toContain("-H 'Keep: me'");
      expect(cmd).not.toContain("ignored");
    });

    it("omits -d when there is no body", () => {
      const cmd = generateCurlCommand(
        { method: "GET", url: "https://example.com/a", headers: [] },
        { platform: "macos" },
      );
      expect(cmd).not.toContain("-d ");
    });
  });

  describe("Windows (cmd / PowerShell)", () => {
    it("double-quotes arguments and stays on a single line", () => {
      const cmd = generateCurlCommand(baseParams, { platform: "windows" });
      // Single line — no `\` continuation (cmd and PowerShell disagree on it).
      expect(cmd).not.toContain("\\\n");
      expect(cmd.startsWith("curl")).toBe(true);
      expect(cmd).toContain("-X POST");
      expect(cmd).toContain('-H "Content-Type: application/json"');
      // Inner quotes are doubled: {"hello":"world"} -> {""hello"":""world""}
      expect(cmd).toContain('-d "{""hello"":""world""}"');
      expect(cmd.endsWith('"https://example.com/api?q=hello"')).toBe(true);
    });

    it("doubles embedded double quotes", () => {
      const cmd = generateCurlCommand(
        {
          method: "POST",
          url: 'https://example.com/a"b',
          headers: [{ name: 'X-Q', value: 'say "hi"', isPseudo: false }],
          body: 'k"v',
        },
        { platform: "windows" },
      );
      // Inner `"` -> `""`.
      expect(cmd).toContain('-H "X-Q: say ""hi"""');
      expect(cmd).toContain('-d "k""v"');
      expect(cmd).toContain('"https://example.com/a""b"');
    });

    it("does not single-quote anything (single quotes are literal in cmd)", () => {
      const cmd = generateCurlCommand(
        {
          method: "GET",
          url: "https://example.com/a",
          headers: [{ name: "X", value: "plain", isPseudo: false }],
        },
        { platform: "windows" },
      );
      expect(cmd).not.toMatch(/-H '/);
      expect(cmd).not.toMatch(/-d '/);
    });

    it("GET omits -X and leaves percent signs untouched", () => {
      const cmd = generateCurlCommand(
        {
          method: "GET",
          url: "https://example.com/a%20b",
          headers: [],
        },
        { platform: "windows" },
      );
      expect(cmd).not.toContain("-X GET");
      expect(cmd).toContain('"https://example.com/a%20b"');
    });
  });
});
