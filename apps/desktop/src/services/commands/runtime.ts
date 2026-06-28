import { coerceAppError } from "@aiproxy/shared-types";

import { logDevError } from "@/services/logger/dev-logger";

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function detectBrowserPlatform(): "linux" | "macos" | "windows" {
  if (typeof navigator === "undefined") return "windows";
  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (ua.includes("linux") || platform.includes("linux")) return "linux";
  if (ua.includes("mac") || platform.includes("mac")) return "macos";
  return "windows";
}

export function reportCommandFailure(commandName: string, error: unknown, workspaceId?: string) {
  logDevError("ui.commands", "command_failed", {
    commandName,
    error,
    occurredAt: new Date().toISOString(),
    workspaceId,
  });
}

export function shouldFallbackToLocalStore(error: unknown): boolean {
  const normalized = coerceAppError(error);
  const message = normalized.message.toLowerCase();

  // L5: this heuristic signals ONLY "the Tauri command is missing / not
  // registered" (the documented dev/web fallback path). The previous bare
  // `message.includes("command")` matched ANY message containing the substring
  // "command" — including genuine backend errors that merely mention the word —
  // causing `save*` wrappers to swallow the real error and silently fall back
  // to localStorage, hiding data that never reached the backend DB.
  return (
    message.includes("not found") ||
    message.includes("unknown command") ||
    message.includes("failed to invoke")
  );
}
