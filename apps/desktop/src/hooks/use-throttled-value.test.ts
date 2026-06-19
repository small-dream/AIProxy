import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useThrottledValue } from "./use-throttled-value";

describe("useThrottledValue", () => {
  it("returns initial value immediately", () => {
    const { result } = renderHook(({ value }) => useThrottledValue(value, 100), {
      initialProps: { value: "a" },
    });
    expect(result.current).toBe("a");
  });

  it("throttles rapid changes and carries the latest value on the trailing edge", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 150), {
      initialProps: { value: "a" },
    });

    // Multiple changes within the same window must not refresh until it elapses.
    rerender({ value: "b" });
    rerender({ value: "c" });
    expect(result.current).toBe("a");

    // The trailing emit carries the latest value, not an intermediate one.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("c");

    vi.useRealTimers();
  });

  it("emits immediately on the leading edge once a window has fully elapsed", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 150), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("b");

    // Advance well past the window with no value change, then a new value
    // should appear without waiting for another timer.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: "d" });
    expect(result.current).toBe("d");

    vi.useRealTimers();
  });

  it("does not starve under continuous changes — each window still emits once", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 100), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("b");

    // Keep changing every 40ms (< 100ms window); the hook must still emit one
    // value per elapsed window rather than postponing forever.
    rerender({ value: "c" });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    rerender({ value: "d" });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    rerender({ value: "e" });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current).toBe("e");

    vi.useRealTimers();
  });

  it("clears the pending timer on unmount without firing", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ value }) => useThrottledValue(value, 150), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    unmount();
    // Advancing past the window must not throw (no setState after unmount).
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(300);
      }),
    ).not.toThrow();

    vi.useRealTimers();
  });
});
