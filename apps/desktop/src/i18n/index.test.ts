import { describe, expect, it } from "vitest";

import { resolveLocale } from "./index";

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
