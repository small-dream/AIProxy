// Load every user guide as a raw string at build time. The @docs alias points at
// apps/desktop/user-guides, keeping a single source of truth for the bundled guides
// without copying markdown into src.
const modules = import.meta.glob("@docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Glob keys may be alias-expanded or absolute, so normalize by basename.
const contentBySlug: Record<string, string> = {};
for (const [path, content] of Object.entries(modules)) {
  const filename = path.split("/").pop() ?? path;
  const slug = filename.replace(/\.md$/i, "");
  if (slug) {
    contentBySlug[slug] = content;
  }
}

/** All slugs present on disk (derived from the glob), sorted alphabetically. */
export const contentSlugs: readonly string[] = Object.keys(contentBySlug).sort();

/** Raw markdown for a slug, or undefined if no matching guide exists. */
export function getDocContent(slug: string): string | undefined {
  return contentBySlug[slug];
}
