import type { ExportFormat } from "@aiproxy/shared-types";

export type SessionsMenuAction =
  | {
      kind: "export";
      format: ExportFormat;
      requestedAt: number;
    }
  | {
      kind: "import-har";
      requestedAt: number;
    };

export function readSessionsMenuAction(state: unknown): SessionsMenuAction | undefined {
  if (typeof state !== "object" || state === null || !("sessionsMenuAction" in state)) {
    return undefined;
  }

  const menuAction = (state as { sessionsMenuAction?: unknown }).sessionsMenuAction;

  if (typeof menuAction !== "object" || menuAction === null) {
    return undefined;
  }

  const requestedAt = (menuAction as { requestedAt?: unknown }).requestedAt;
  const kind = (menuAction as { kind?: unknown }).kind;

  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) {
    return undefined;
  }

  if (kind === "import-har") {
    return { kind, requestedAt };
  }

  const format = (menuAction as { format?: unknown }).format;

  if (
    kind === "export"
    && (format === "curl" || format === "har" || format === "json")
  ) {
    return {
      format,
      kind,
      requestedAt,
    };
  }

  return undefined;
}
