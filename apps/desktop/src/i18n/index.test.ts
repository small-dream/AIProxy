import { describe, expect, it } from "vitest";

import { resolveLocale, translateMessage, type TranslationKey } from "./index";
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

describe("list reorder hint", () => {
  it("interpolates the platform accelerator instead of leaking the placeholder", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const message = translateMessage(locale, "rulesPage.listReorderHint", { alt: "⌥↑/↓" });

      expect(message).toContain("⌥↑/↓");
      expect(message).not.toContain("{{");
    }
  });
});

describe("localized HTTP terminology", () => {
  it("keeps Chinese labels consistent across request editors and inspectors", () => {
    const labels: Partial<Record<TranslationKey, string>> = {
      "common.labels.host": "主机",
      "settingsPage.aiApiKey": "API 密钥",
      "settingsPage.aiBaseUrl": "服务地址",
      "insightsPage.hosts.contextMenu.filterByHost": "按此主机过滤",
      "docsPage.entries.dnsMapping": "DNS 映射",
      "composePage.tabs.headers": "请求头",
      "composePage.tabs.body": "请求体",
      "composePage.tabs.query": "查询参数",
      "composePage.bodyTypes.formdata": "多部分表单",
      "composePage.bodyTypes.urlencoded": "URL 编码表单",
      "composePage.bodyTypes.raw": "原始内容",
      "inspector.request.tabs.headers": "请求头",
      "inspector.request.tabs.body": "请求体",
      "inspector.response.tabs.headers": "响应头",
      "inspector.response.tabs.trailers": "尾部字段",
      "breakpointPanel.requestBody": "请求体",
      "breakpointPanel.responseBody": "响应体",
      "rulesPage.rewrite.types.header": "消息头",
      "rulesPage.rewrite.types.body": "消息体",
      "settingsPage.agentAccess.readBodiesLabel": "读取消息体",
    };
    for (const [key, expected] of Object.entries(labels)) {
      expect(translateMessage("zh-CN", key as TranslationKey)).toBe(expected);
    }
  });

  it("distinguishes an absent request body, uncaptured content, and an empty response", () => {
    expect(translateMessage("zh-CN", "composePage.noBody")).toBe("此请求不发送请求体。");
    expect(translateMessage("zh-CN", "inspector.request.noBodyCaptured")).toBe("未捕获请求体");
    expect(translateMessage("zh-CN", "inspector.response.noResponseBodyCaptured")).toBe(
      "未捕获响应体",
    );
    expect(translateMessage("zh-CN", "inspector.response.emptyBodyReceived")).toContain("0 字节");
  });

  it("retains protocol identifiers and actual field examples", () => {
    expect(zhCNMessages.composePage.bodyTypeDescriptions.formdata).toContain("multipart/form-data");
    expect(zhCNMessages.composePage.bodyTypeDescriptions.urlencoded).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(zhCNMessages.rulesPage.rewrite.contentType).toBe("Content-Type");
    expect(zhCNMessages.rulesPage.rewrite.headerNameExample).toBe("x-debug-mode");
    expect(zhCNMessages.rulesPage.rewrite.bodyFieldPathExample).toBe("data.user.name");
    expect(enMessages.composePage.tabs.headers).toBe("Headers");
  });

  it("does not leave standalone English HTTP UI terms in Chinese messages", () => {
    const untranslated: string[] = [];
    function visit(node: unknown, prefix = "") {
      if (typeof node === "string") {
        if (
          /\b(?:Headers?|Body|Query|Raw|Trailers|Request|Response|Redirect|Timing|Diff|Host|domain|Snapshot|generation|schema|sidecar|trace)\b/.test(
            node,
          )
        ) {
          untranslated.push(prefix);
        }
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node))
          visit(value, prefix ? prefix + "." + key : key);
      }
    }
    visit(zhCNMessages);
    expect(untranslated).toEqual([]);
  });

  it("preserves interpolation placeholders in both message catalogs", () => {
    for (const key of collectKeyPaths(enMessages)) {
      const readValue = (catalog: typeof enMessages | typeof zhCNMessages) => {
        const value = key
          .split(".")
          .reduce<unknown>((node, segment) => (node as Record<string, unknown>)[segment], catalog);
        return Array.isArray(value) ? value.join("\n") : String(value);
      };
      const en = readValue(enMessages);
      const zh = readValue(zhCNMessages);
      expect(zh.match(/\{\{\s*\w+\s*\}\}/g)?.sort() ?? [], key).toEqual(
        en.match(/\{\{\s*\w+\s*\}\}/g)?.sort() ?? [],
      );
    }
  });
});
