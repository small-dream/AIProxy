/**
 * localStorage helpers shared by pages and features.
 *
 * `getItem` returns `null` for a missing key, and `Number(null)` is `0` —
 * which is finite, so the common `Number.isFinite(Number(raw))` guard silently
 * treats "never saved" as "saved 0" and clamps every first-run layout to its
 * minimum (P2-4). Always go through `readStoredNumber` for numeric
 * preferences.
 */

export function readStorageValue(key: string): string | null {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return null;
  }

  return window.localStorage.getItem(key);
}

export function writeStorageValue(key: string, value: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(key, value);
}

export function removeStorageValue(key: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.removeItem !== "function") {
    return;
  }

  window.localStorage.removeItem(key);
}

/**
 * Read a numeric preference, falling back to `fallback` when the key is absent,
 * blank or not a finite number. An explicit stored `"0"` is honoured (it is a
 * real value the caller may clamp), which is why the missing-key case cannot be
 * detected after the fact by inspecting the parsed number.
 */
export function readStoredNumber(key: string, fallback: number): number {
  const raw = readStorageValue(key);
  if (raw === null || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
