import { describe, expect, it } from "vitest";

import { resolveLocale } from "./index";
import { enMessages } from "./messages/en";
import { zhCNMessages } from "./messages/zh-CN";

describe("resolveLocale", () => {
  it("maps Chinese system locales to zh-CN", () => {
    expect(resolveLocale("system", ["zh-TW", "en-US"], "en-US")).toBe("zh-CN");
  });

  it("maps English system locales to en", () => {
    expect(resolveLocale("system", ["en-GB"], "zh-CN")).toBe("en");
  });

  it("falls back to explicit preference when provided", () => {
    expect(resolveLocale("zh-CN", ["en-US"], "en-US")).toBe("zh-CN");
    expect(resolveLocale("en", ["zh-CN"], "zh-CN")).toBe("en");
  });

  it("falls back to English for unsupported languages", () => {
    expect(resolveLocale("system", ["fr-FR"], "de-DE")).toBe("en");
  });
});

// H14: en and zh-CN must expose the same set of translation keys. The type
// system already enforces structural equality (`zhCNMessages: Messages`), but a
// runtime check catches cases where a key is added to one catalog and the other
// is touched by a widening type (e.g. an `any`) or an accidental default — which
// would silently render English in the Chinese UI.
function collectKeyPaths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return prefix ? [prefix] : [];

  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];

  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return collectKeyPaths(value, path);
    }
    return [path];
  });
}

describe("message catalog key parity (H14)", () => {
  it("en and zh-CN expose identical key sets", () => {
    const enKeys = collectKeyPaths(enMessages).sort();
    const zhKeys = collectKeyPaths(zhCNMessages).sort();

    expect(enKeys).toEqual(zhKeys);
  });
});
