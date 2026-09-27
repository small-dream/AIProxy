import type { SupportedLocale } from "@/i18n";

const LOCALIZED_SECTION_HEADINGS: Record<SupportedLocale, string> = {
  "zh-CN": "## 更新内容",
  en: "## What's new",
};

const SECTION_HEADING = /^##\s/;

/**
 * Extract the changelog section matching the active locale from the bilingual
 * release notes served by the updater (docs/releases/v<version>.md plus the
 * install instructions appended by the release workflow). Returns "" when the
 * section is missing so callers can render a friendly fallback instead of the
 * raw bilingual markdown.
 */
export function pickLocalizedChangelog(
  markdown: string | undefined,
  locale: SupportedLocale,
): string {
  if (!markdown) {
    return "";
  }

  const heading = LOCALIZED_SECTION_HEADINGS[locale];
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    return "";
  }

  const section: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || SECTION_HEADING.test(line)) {
      break;
    }
    section.push(line);
  }
  return section.join("\n").trim();
}
