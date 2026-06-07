import { coerceAppError } from "@aiproxy/shared-types";

/**
 * Extracts a human-readable error message from an unknown error.
 * Falls back to `fallbackMessage` if the error message is empty.
 */
export function getErrorMessage(error: unknown, fallbackMessage: string) {
  const normalizedError = coerceAppError(error);

  if (normalizedError.message.trim().length > 0) {
    return normalizedError.message;
  }

  return fallbackMessage;
}

/**
 * Checks whether an error indicates that a port is already in use.
 */
export function isPortInUseError(error: unknown) {
  const normalizedError = coerceAppError(error);
  const normalizedMessage = normalizedError.message.toLowerCase();

  return (
    normalizedError.code === "PORT_IN_USE" ||
    normalizedMessage.includes("already in use") ||
    normalizedMessage.includes("address already in use")
  );
}

/**
 * Returns true when running inside a Tauri desktop shell.
 */
export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Returns true when running on a macOS platform.
 */
export function isMacPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";

  // Exclude Linux before checking for Mac — some Linux desktop themes may
  // appear in UA strings but should never get the macOS overlay titlebar.
  if (ua.includes("linux") || platform.includes("linux")) {
    return false;
  }

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}
