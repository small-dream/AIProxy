import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionExplorerLayout } from "./use-session-explorer-layout";

// M21: unmounting mid-drag must remove the window pointer listeners (and
// release the pointer capture) instead of leaking them until an unrelated
// pointerup fires elsewhere.

function fakeResizeEvent() {
  const target = {
    parentElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, height: 100 }),
    },
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  };
  const event = {
    clientX: 300,
    clientY: 50,
    currentTarget: target,
    pointerId: 1,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLDivElement>;
  return { event, target };
}

function renderLayout() {
  return renderHook(() =>
    useSessionExplorerLayout({ updateContainer: vi.fn(), requestCollapsed: false }),
  );
}

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

describe("useSessionExplorerLayout resize cleanup (M21)", () => {
  beforeEach(() => {
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the window pointer listeners and releases the capture on mid-drag unmount", () => {
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderLayout();
    const { event, target } = fakeResizeEvent();

    act(() => {
      result.current.startExplorerResize(event);
    });
    // Listeners are registered for the in-flight drag.
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);

    unmount();

    const removedTypes = removeListenerSpy.mock.calls.map(([type]) => type);
    expect(removedTypes).toContain("pointermove");
    expect(removedTypes).toContain("pointerup");
    expect(removedTypes).toContain("pointercancel");
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);

    removeListenerSpy.mockRestore();
  });

  it("does not remove listeners twice when the drag ends before unmount", () => {
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderLayout();
    const { event } = fakeResizeEvent();

    act(() => {
      result.current.startInspectorResize(event);
    });
    // End the drag normally via pointerup.
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    const callsAfterPointerUp = removeListenerSpy.mock.calls.length;

    unmount();

    // The unmount cleanup must be a no-op: stopResize already ran and cleared
    // the ref, so no further removals happen on unmount.
    expect(removeListenerSpy.mock.calls.length).toBe(callsAfterPointerUp);

    removeListenerSpy.mockRestore();
  });
});
