import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useZoomControl } from "./use-zoom-control";

// P7: the ±0.1 zoom step used to accumulate floating-point error
// (1 + 0.1×3 → 1.3000000000000003), drifting off the preset grid.

// jsdom in this repo provides no localStorage; stub it like the other tests.
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

describe("useZoomControl zoom stepping", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
  });

  it("keeps the zoom level on the 0.1 grid after repeated zoom-in steps", () => {
    const { result } = renderHook(() => useZoomControl());

    act(() => {
      for (let i = 0; i < 3; i += 1) {
        window.dispatchEvent(new Event("aiproxy-menu-zoom-in"));
      }
    });

    expect(result.current.zoomLevel).toBe(1.3);
  });

  it("keeps the zoom level on the 0.1 grid after repeated zoom-out steps", () => {
    const { result } = renderHook(() => useZoomControl());

    act(() => {
      for (let i = 0; i < 3; i += 1) {
        window.dispatchEvent(new Event("aiproxy-menu-zoom-out"));
      }
    });

    expect(result.current.zoomLevel).toBe(0.7);
  });

  it("still clamps at the 2.0 ceiling after rounding", () => {
    const { result } = renderHook(() => useZoomControl());

    act(() => {
      for (let i = 0; i < 15; i += 1) {
        window.dispatchEvent(new Event("aiproxy-menu-zoom-in"));
      }
    });

    expect(result.current.zoomLevel).toBe(2);
  });
});
