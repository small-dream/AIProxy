import type { HeaderEntry } from "@aiproxy/shared-types";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const EXPLORER_WIDTH_STORAGE_KEY = "aiproxy.collections.explorerWidth";
export const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.collections.inspectorSplitRatio";
export const REQUEST_COLLAPSED_STORAGE_KEY = "aiproxy.collections.requestCollapsed";

export const EXPLORER_WIDTH_MIN = 260;
export const EXPLORER_WIDTH_MAX = 520;
export const APPEND_SORT_ORDER = 0xffffffff;

/** Clamp the explorer pane width to its allowed range. */
export function clampExplorerWidth(width: number): number {
  return Math.min(EXPLORER_WIDTH_MAX, Math.max(EXPLORER_WIDTH_MIN, width));
}

/** Append a Content-Type header if one is not already present. */
export function ensureContentType(headers: HeaderEntry[], contentType: string): HeaderEntry[] {
  if (headers.some((h) => h.name.toLowerCase() === "content-type")) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}
