import { describe, expect, it } from "vitest";

import { docsEntries } from "./docs-manifest";
import { contentSlugs, contentSlugsByLocale } from "./docs-content";
import { groupDocsEntries, resolveDocLink, resolveInitialSlug } from "./docs-navigation";
import { slugifyDocHeading } from "@/lib/markdown-heading";

const firstSlug = docsEntries[0]?.slug ?? "";

describe("groupDocsEntries", () => {
  it("groups entries by docsGroupOrder and sorts within each group", () => {
    const grouped = groupDocsEntries();

    expect(grouped.map((group) => group.group)).toEqual([
      "getting-started",
      "capture",
      "rules",
      "advanced",
    ]);

    const rulesGroup = grouped.find((group) => group.group === "rules");
    expect(rulesGroup?.entries.map((entry) => entry.slug)).toEqual([
      "rewrite-rules",
      "script-rules",
      "script-rules-examples",
      "throttling",
      "breakpoints",
      "map-rules",
    ]);
  });

  it("omits groups that have no entries", () => {
    const grouped = groupDocsEntries(docsEntries.slice(0, 1));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.entries).toHaveLength(1);
  });
});

describe("resolveInitialSlug", () => {
  it("returns the slug when it matches a known entry", () => {
    expect(resolveInitialSlug("rewrite-rules")).toBe("rewrite-rules");
  });

  it("falls back to the first entry for unknown slugs", () => {
    expect(resolveInitialSlug("does-not-exist")).toBe(firstSlug);
  });

  it("falls back to the first entry when the param is missing", () => {
    expect(resolveInitialSlug(null)).toBe(firstSlug);
    expect(resolveInitialSlug(undefined)).toBe(firstSlug);
    expect(resolveInitialSlug("")).toBe(firstSlug);
  });
});

describe("resolveDocLink", () => {
  it("resolves relative markdown refs to slugs", () => {
    expect(resolveDocLink("./script-rules.md")).toEqual({ slug: "script-rules" });
    expect(resolveDocLink("script-rules.md")).toEqual({ slug: "script-rules" });
  });

  it("resolves absolute paths by their trailing filename", () => {
    expect(resolveDocLink("/Users/x/aiproxy/apps/desktop/user-guides/script-rules.md")).toEqual({
      slug: "script-rules",
    });
  });

  it("keeps the heading anchor of a cross-guide link", () => {
    // P3: dropping the fragment always landed at the top of the target guide.
    expect(resolveDocLink("./rewrite-rules.md#规则导入--导出")).toEqual({
      anchor: "规则导入--导出",
      slug: "rewrite-rules",
    });
    expect(resolveDocLink("./script-rules.md#section")).toEqual({
      anchor: "section",
      slug: "script-rules",
    });
    // Percent-encoded anchors are decoded; a malformed one is kept verbatim.
    expect(resolveDocLink("./a.md#%E4%B8%AD%E6%96%87")).toEqual({
      anchor: "中文",
      slug: "a",
    });
    expect(resolveDocLink("./a.md#%zz")).toEqual({ anchor: "%zz", slug: "a" });
  });

  it("strips query suffixes before extracting the slug", () => {
    expect(resolveDocLink("./script-rules.md?lang=en")).toEqual({ slug: "script-rules" });
  });

  it("returns null for external links, anchors, and empty input", () => {
    expect(resolveDocLink("https://example.com")).toBeNull();
    expect(resolveDocLink("http://example.com/guide.md")).toBeNull();
    expect(resolveDocLink("mailto:user@example.com")).toBeNull();
    expect(resolveDocLink("#section")).toBeNull();
    expect(resolveDocLink(undefined)).toBeNull();
    expect(resolveDocLink("")).toBeNull();
  });

  it("returns null for non-markdown relative refs so they are not swallowed", () => {
    expect(resolveDocLink("./image.png")).toBeNull();
    expect(resolveDocLink("../assets/file.zip")).toBeNull();
    expect(resolveDocLink("README")).toBeNull();
  });
});

describe("slugifyDocHeading", () => {
  it("matches GitHub heading slugs, including CJK and punctuation", () => {
    expect(slugifyDocHeading("规则导入 / 导出")).toBe("规则导入--导出");
    expect(slugifyDocHeading("Packet-loss recovery test")).toBe("packet-loss-recovery-test");
    expect(slugifyDocHeading("API 参考 / Reference")).toBe("api-参考--reference");
  });
});

describe("manifest <-> content consistency", () => {
  it("every manifest slug has a matching guide file", () => {
    for (const entry of docsEntries) {
      expect(contentSlugs).toContain(entry.slug);
    }
  });
});

describe("bilingual parity", () => {
  it("en and zh-CN expose the same slug set", () => {
    expect([...contentSlugsByLocale.en]).toEqual([...contentSlugsByLocale["zh-CN"]]);
  });

  it("every manifest slug exists in both locales", () => {
    for (const entry of docsEntries) {
      expect(contentSlugsByLocale.en).toContain(entry.slug);
      expect(contentSlugsByLocale["zh-CN"]).toContain(entry.slug);
    }
  });
});
