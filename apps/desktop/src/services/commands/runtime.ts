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

// Exact shape of the rejection Tauri 2 emits for an unregistered command:
// `resolver.reject(format!("Command {command} not found"))` (tauri src/webview/mod.rs),
// e.g. "Command save_rewrite_rule not found". The regex is anchored on the
// "Command <name> " prefix so genuine backend entity errors — db::Error::NotFound
// renders as "{entity} not found: {id}" (crates/db/src/error.rs), e.g.
// "workspace not found: abc" — never match and surface to the caller instead of
// silently rewriting localStorage. ACL denials ("... not allowed. Command not
// found") are also deliberately excluded: they are a misconfiguration to report,
// not a missing command.
const TAURI_UNREGISTERED_COMMAND_PATTERN = /^command\s+\S+\s+not found$/i;

export function shouldFallbackToLocalStore(error: unknown): boolean {
  const normalized = coerceAppError(error);
  const message = normalized.message.trim();

  // Fallback is reserved for the documented dev/web path where the Tauri
  // command is missing / not registered. Every other error (backend entity
  // errors included) must propagate so the caller can surface it.
  return TAURI_UNREGISTERED_COMMAND_PATTERN.test(message);
}
