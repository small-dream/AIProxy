import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime", () => ({
  reportCommandFailure: vi.fn(),
}));

import { reportCommandFailure } from "./runtime";
import { readStoredRules, upsertStoredEntity, writeStoredRules } from "./local-store.helpers";

const STORAGE_KEY = "aiproxy.test.local-store";

// The test jsdom provides no localStorage; stub it like the other storage
// tests in this repo (see features/environments/active-environment.test.ts).
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

describe("local-store helpers", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    vi.mocked(reportCommandFailure).mockClear();
  });

  it("returns an empty list when nothing is stored", () => {
    expect(readStoredRules(STORAGE_KEY, (value) => value as string[])).toEqual([]);
  });

  it("round-trips values through writeStoredRules/readStoredRules", () => {
    writeStoredRules(STORAGE_KEY, [{ id: "rule-1" }]);

    const stored = readStoredRules(STORAGE_KEY, (value) => value as Array<{ id: string }>);
    expect(stored).toEqual([{ id: "rule-1" }]);
  });

  it("reports malformed JSON and degrades to an empty list", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not-json");

    const stored = readStoredRules(STORAGE_KEY, (value) => value as string[]);

    expect(stored).toEqual([]);
    expect(reportCommandFailure).toHaveBeenCalledWith(
      `read_local_store:${STORAGE_KEY}`,
      expect.anything(),
    );
  });

  it("upsertStoredEntity appends new entities and replaces existing ones", () => {
    const items = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ];

    expect(upsertStoredEntity(items, { id: "c", value: 3 })).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "c", value: 3 },
    ]);
    expect(upsertStoredEntity(items, { id: "b", value: 20 })).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 20 },
    ]);
  });
});
