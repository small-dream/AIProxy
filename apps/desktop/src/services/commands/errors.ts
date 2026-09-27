/**
 * Error carrying a stable machine code alongside the human message.
 *
 * Thrown (instead of a plain object) so callers keep a real `Error` stack trace,
 * `instanceof Error` checks hold, and TanStack Query / Sentry can classify it.
 * The `code` field preserves the structured signaling the previous plain-object
 * throws relied on (M10).
 */
export class AppCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AppCommandError";
    this.code = code;
  }
}
