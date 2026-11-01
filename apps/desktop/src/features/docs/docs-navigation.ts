import { docsEntries, docsGroupOrder, type DocsEntry, type DocsGroup } from "./docs-manifest";

export interface GroupedDocs {
  group: DocsGroup;
  entries: DocsEntry[];
}

/** Group entries by their TOC group, preserving docsGroupOrder and each entry's order. */
export function groupDocsEntries(entries: DocsEntry[] = docsEntries): GroupedDocs[] {
  return docsGroupOrder
    .map((group) => ({
      group,
      entries: entries.filter((entry) => entry.group === group).sort((a, b) => a.order - b.order),
    }))
    .filter((grouped) => grouped.entries.length > 0);
}

/**
 * Resolve the active slug from a raw ?doc= search param. Falls back to the first
 * entry when missing or unknown so the page always renders a guide.
 */
export function resolveInitialSlug(
  rawSlug: string | null | undefined,
  entries: DocsEntry[] = docsEntries,
): string {
  if (rawSlug && entries.some((entry) => entry.slug === rawSlug)) {
    return rawSlug;
  }
  return entries[0]?.slug ?? "";
}

export type DocLinkTarget = {
  slug: string;
  /** GitHub-style heading anchor carried by the link (`…md#规则导入--导出`). */
  anchor?: string;
};

/**
 * Normalize a markdown href to a doc slug plus optional heading anchor. Handles
 * relative refs (./x.md, x.md) and absolute paths by their trailing filename.
 * Returns null for anything with a scheme (http:, mailto:, ...) or an in-page
 * anchor, so callers can route those elsewhere (external browser / scroll).
 */
export function resolveDocLink(href: string | undefined): DocLinkTarget | null {
  if (!href) {
    return null;
  }

  if (/^[a-z]+:/i.test(href) || href.startsWith("#")) {
    return null;
  }

  const pathPart = href.split(/[?#]/)[0] ?? "";
  const filename = pathPart.split("/").pop();
  // Only treat markdown references as internal doc links; other relative refs
  // (images, archives, bare README, ...) fall through to default anchor behavior
  // instead of being swallowed by preventDefault.
  if (!filename || !/\.md$/i.test(filename)) {
    return null;
  }

  const slug = filename.replace(/\.md$/i, "");
  if (!slug) {
    return null;
  }

  const hashIndex = href.indexOf("#");
  const anchor = hashIndex >= 0 ? decodeAnchor(href.slice(hashIndex + 1)) : "";

  // Cross-page links used to drop their `#fragment`, so "导入 / 导出" links
  // always landed at the top of the target guide (P3).
  return anchor ? { anchor, slug } : { slug };
}

function decodeAnchor(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}
