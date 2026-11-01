import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readStorageValue, readStoredNumber, writeStorageValue } from "./storage";

// jsdom in this repo provides no localStorage; stub it like the other tests.
const storage = new Map<string, string>();

describe("readStoredNumber", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    storage.clear();
  });

  // P2-4: `Number(null) === 0` used to be accepted as a saved value, so every
  // first-run layout was clamped to its minimum instead of using the default.
  it("returns the fallback when the key was never written", () => {
    expect(readStorageValue("missing")).toBeNull();
    expect(readStoredNumber("missing", 360)).toBe(360);
  });

  it("returns the fallback for blank and non-numeric values", () => {
    storage.set("blank", "   ");
    storage.set("garbage", "not-a-number");
    storage.set("nan", "NaN");

    expect(readStoredNumber("blank", 0.38)).toBe(0.38);
    expect(readStoredNumber("garbage", 0.38)).toBe(0.38);
    expect(readStoredNumber("nan", 0.38)).toBe(0.38);
  });

  it("honours an explicit stored zero", () => {
    storage.set("zero", "0");

    expect(readStoredNumber("zero", 360)).toBe(0);
  });

  it("parses decimal and negative values", () => {
    storage.set("ratio", "0.42");
    storage.set("negative", "-1.5");

    expect(readStoredNumber("ratio", 0.38)).toBeCloseTo(0.42);
    expect(readStoredNumber("negative", 0)).toBeCloseTo(-1.5);
  });
});

describe("storage access", () => {
  it("round-trips through writeStorageValue", () => {
    writeStorageValue("persisted", "value");

    expect(readStorageValue("persisted")).toBe("value");
  });
});
