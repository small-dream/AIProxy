import { reportCommandFailure } from "./runtime";

/**
 * Shared localStorage-backed store helpers for the web/dev fallback of the
 * rule commands (rewrite/map/dns/script/throttle). The Tauri path owns
 * persistence; these only keep the non-Tauri development runtime consistent.
 */
export function readStoredRules<T>(storageKey: string, parser: (value: unknown) => T[]): T[] {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return [];
  }

  const rawValue = window.localStorage.getItem(storageKey);

  if (!rawValue) {
    return [];
  }

  try {
    return parser(JSON.parse(rawValue));
  } catch (error) {
    reportCommandFailure(`read_local_store:${storageKey}`, error);
    return [];
  }
}

export function writeStoredRules(storageKey: string, value: unknown) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(value));
}

export function upsertStoredEntity<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);

  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}
