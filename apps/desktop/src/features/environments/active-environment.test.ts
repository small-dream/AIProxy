import { beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVE_ENV_STORAGE_KEY,
  readActiveEnvironmentId,
  writeActiveEnvironmentId,
} from "./active-environment";

const LEGACY_KEY = "aiproxy.collections.activeEnvironmentId";

const storage = new Map<string, string>();
const localStorageMock = {
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  removeItem: (key: string) => {
    storage.delete(key);
  },
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
};

describe("active-environment storage", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
  });

  it("returns null when nothing is stored", () => {
    expect(readActiveEnvironmentId()).toBeNull();
  });

  it("reads the shared key", () => {
    window.localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, "env-1");
    expect(readActiveEnvironmentId()).toBe("env-1");
  });

  it("migrates the legacy collections key on first read and writes the new key", () => {
    window.localStorage.setItem(LEGACY_KEY, "env-legacy");
    expect(readActiveEnvironmentId()).toBe("env-legacy");
    expect(window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY)).toBe("env-legacy");
  });

  it("prefers the new key over the legacy key", () => {
    window.localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, "env-new");
    window.localStorage.setItem(LEGACY_KEY, "env-legacy");
    expect(readActiveEnvironmentId()).toBe("env-new");
  });

  it("writeActiveEnvironmentId persists and clears the shared key", () => {
    writeActiveEnvironmentId("env-2");
    expect(window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY)).toBe("env-2");

    writeActiveEnvironmentId(null);
    expect(window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY)).toBeNull();
  });
});
