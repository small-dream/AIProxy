import type { SupportedLocale } from "@/i18n";

// User guides are bundled into the app bilingually. Each locale lives in its own
// directory under apps/desktop/user-guides (<locale>/<slug>.md), loaded as a raw
// string at build time via the @docs alias. Both locales must stay 1:1 in slugs —
// this is enforced by the bilingual parity test, so the runtime never needs a
// fallback: getDocContent returns exactly the requested locale's content.

function indexGlob(modules: Record<string, string>): Record<string, string> {
  // Glob keys may be alias-expanded or absolute, so normalize by basename.
  const bySlug: Record<string, string> = {};
  for (const [path, content] of Object.entries(modules)) {
    const filename = path.split("/").pop() ?? path;
    const slug = filename.replace(/\.md$/i, "");
    if (slug) {
      bySlug[slug] = content;
    }
  }
  return bySlug;
}

const enModules = import.meta.glob("@docs/en/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const zhCNModules = import.meta.glob("@docs/zh-CN/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Content per locale, keyed by slug. Exact-match only (no fallback); the bilingual
// parity test guarantees both maps carry every manifest slug.
const contentByLocale: Record<SupportedLocale, Record<string, string>> = {
  en: indexGlob(enModules),
  "zh-CN": indexGlob(zhCNModules),
};

/** Slugs available in at least one locale (union), sorted alphabetically. */
export const contentSlugs: readonly string[] = [
  ...new Set([...Object.keys(contentByLocale.en), ...Object.keys(contentByLocale["zh-CN"])]),
].sort();

/** Slugs available per locale, sorted alphabetically. Used by the bilingual parity test. */
export const contentSlugsByLocale: Record<SupportedLocale, readonly string[]> = {
  en: Object.keys(contentByLocale.en).sort(),
  "zh-CN": Object.keys(contentByLocale["zh-CN"]).sort(),
};

/** Raw markdown for a slug in the requested locale, or undefined if missing. */
export function getDocContent(slug: string, locale: SupportedLocale): string | undefined {
  return contentByLocale[locale]?.[slug];
}
