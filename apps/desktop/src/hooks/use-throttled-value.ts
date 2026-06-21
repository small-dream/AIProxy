import { useEffect, useRef, useState } from "react";

/**
 * Returns a throttled copy of `value`.
 *
 * Emits the latest value on the leading edge of each `intervalMs` window and
 * guarantees one trailing emit, so the final value is never dropped. Unlike
 * {@link useDebouncedValue}, continuous changes still refresh at a steady
 * cadence instead of being postponed until changes stop. This is meant to drive
 * live computations off a fast-changing store without recomputing on every
 * single tick.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmittedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(value);

  useEffect(() => {
    // Keep the latest value available to the trailing timer's callback. Written
    // in the effect (not during render) to stay within React's ref rules.
    latestRef.current = value;

    const now = Date.now();
    const elapsed = now - lastEmittedRef.current;

    // Leading edge: enough time has passed since the last emit — refresh now.
    if (elapsed >= intervalMs) {
      lastEmittedRef.current = now;
      setThrottled(value);
      return;
    }

    // Otherwise schedule a single trailing emit for the end of this window.
    // Reuse the pending timer so rapid changes don't keep pushing it back
    // (which would turn this into a debounce).
    if (timerRef.current) {
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastEmittedRef.current = Date.now();
      setThrottled(latestRef.current);
    }, intervalMs - elapsed);
  }, [value, intervalMs]);

  // When the throttle interval changes, drop any timer scheduled under the old
  // interval and reset the emit baseline so the new window starts clean (L13).
  // Without this, a stale timer fires on the old cadence and the leading-edge
  // check compares against a timestamp from the previous interval.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastEmittedRef.current = 0;
    };
  }, [intervalMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return throttled;
}
