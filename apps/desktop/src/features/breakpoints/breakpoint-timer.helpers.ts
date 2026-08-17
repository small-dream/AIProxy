import { BREAKPOINT_WAIT_TIMEOUT_MS } from "@aiproxy/shared-types";

/**
 * Countdown helpers for the breakpoint auto-release window (review §4.3).
 * The backend forwards an unresolved hit unchanged after
 * BREAKPOINT_WAIT_TIMEOUT; these drive the in-panel countdown chip.
 */

/** Remaining wait time in ms, clamped at 0 (never negative). */
export function remainingMs(
  receivedAt: number,
  now: number,
  timeoutMs: number = BREAKPOINT_WAIT_TIMEOUT_MS,
): number {
  return Math.max(0, receivedAt + timeoutMs - now);
}

/** Format as m:ss with whole (floored) seconds, e.g. 299_999 → "4:59". */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** True inside the final stretch of the wait window (UI turns warning). */
export function isExpiringSoon(ms: number, thresholdMs: number = 30_000): boolean {
  return ms <= thresholdMs;
}
