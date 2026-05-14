import { useSyncExternalStore } from "react";

const STORAGE_KEY = "aiproxy.sessions.compareScopes";
const CHANGE_EVENT = "aiproxy:sessions:compare-scopes-changed";

let cachedScopes: SessionCompareScope[] | undefined;

export type SessionCompareScope = {
  id: string;
  label: string;
  sessionIds: string[];
  updatedAt: string;
};

export function syncSessionCompareScopes(scopes: SessionCompareScope[]) {
  cachedScopes = scopes;
  writeScopes(scopes);
  dispatchChange();
}

export function useSessionCompareScopes(): SessionCompareScope[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => []);
}

export function readSessionCompareScopes(): SessionCompareScope[] {
  return readStoredScopes();
}

function getSnapshot() {
  if (!cachedScopes) {
    cachedScopes = readStoredScopes();
  }

  return cachedScopes;
}

function readStoredScopes(): SessionCompareScope[] {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isSessionCompareScope);
  } catch {
    return [];
  }
}

function writeScopes(scopes: SessionCompareScope[]) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scopes));
}

function subscribe(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cachedScopes = readStoredScopes();
      callback();
    }
  };
  const handleLocalChange = () => {
    cachedScopes = readStoredScopes();
    callback();
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, handleLocalChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, handleLocalChange);
  };
}

function dispatchChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

function isSessionCompareScope(value: unknown): value is SessionCompareScope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionCompareScope>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every((sessionId) => typeof sessionId === "string") &&
    typeof candidate.updatedAt === "string"
  );
}
