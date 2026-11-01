/**
 * GitHub-compatible markdown heading slug.
 *
 * Lowercases, drops punctuation, and replaces every space with a single `-`
 * (without collapsing runs), so `规则导入 / 导出` becomes `规则导入--导出` — the
 * exact anchor the guides link to. Used for heading ids in the in-app markdown
 * renderer so `#section` and `…md#section` links can scroll.
 */
export function slugifyDocHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}
