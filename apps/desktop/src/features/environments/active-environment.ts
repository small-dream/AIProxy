/**
 * Shared active-environment storage (C1). Both the Collections and Compose
 * pages read/write the same key so they converge on one active environment.
 */
export const ACTIVE_ENV_STORAGE_KEY = "aiproxy.activeEnvironmentId";

/** Legacy Collections-only key; migrated on first read (D7). */
const LEGACY_ACTIVE_ENV_STORAGE_KEY = "aiproxy.collections.activeEnvironmentId";

export function readActiveEnvironmentId(): string | null {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return null;
  }

  const current = window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY);
  if (current !== null) return current;

  const legacy = window.localStorage.getItem(LEGACY_ACTIVE_ENV_STORAGE_KEY);
  if (legacy !== null) {
    window.localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, legacy);
    return legacy;
  }
  return null;
}

export function writeActiveEnvironmentId(environmentId: string | null) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }
  if (environmentId) {
    window.localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, environmentId);
  } else {
    window.localStorage.removeItem(ACTIVE_ENV_STORAGE_KEY);
  }
}
