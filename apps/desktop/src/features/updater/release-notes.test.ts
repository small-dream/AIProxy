import { describe, expect, it } from "vitest";

import { pickLocalizedChangelog } from "@/features/updater/release-notes";

const BILINGUAL_NOTES = `# AIProxy v0.1.30

## 更新内容

- 新增一项中文功能。

## What's new

- Added an English feature.

## 安装与更新

- 中文安装说明，不应出现在 changelog 中。

---

## Install and update

- English install notes, should not appear in the changelog.
`;

describe("pickLocalizedChangelog", () => {
  it("extracts the Chinese changelog section", () => {
    expect(pickLocalizedChangelog(BILINGUAL_NOTES, "zh-CN")).toBe("- 新增一项中文功能。");
  });

  it("extracts the English changelog section", () => {
    expect(pickLocalizedChangelog(BILINGUAL_NOTES, "en")).toBe("- Added an English feature.");
  });

  it("never includes the install-and-update sections", () => {
    const zh = pickLocalizedChangelog(BILINGUAL_NOTES, "zh-CN");
    const en = pickLocalizedChangelog(BILINGUAL_NOTES, "en");
    expect(zh).not.toContain("安装说明");
    expect(en).not.toContain("install notes");
  });

  it("keeps multiple bullet lines in order", () => {
    const markdown =
      "## What's new\n\n- First.\n- Second.\n\n## Install and update\n\n- Ignore me.\n";
    expect(pickLocalizedChangelog(markdown, "en")).toBe("- First.\n- Second.");
  });

  it("returns '' when the locale section is missing", () => {
    expect(pickLocalizedChangelog("## What's new\n\n- Only English.\n", "zh-CN")).toBe("");
  });

  it("returns '' for empty or undefined markdown", () => {
    expect(pickLocalizedChangelog("", "en")).toBe("");
    expect(pickLocalizedChangelog(undefined, "en")).toBe("");
  });
});
