import { coerceAppError } from "./common";

export type Workspace = {
  id: string;
  name: string;
  proxyPort: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
};

export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<Workspace>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.proxyPort === "number" &&
    typeof candidate.sslEnabled === "boolean" &&
    typeof candidate.systemProxyEnabled === "boolean" &&
    typeof candidate.storagePath === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function parseWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isWorkspace)) {
    return value;
  }

  throw coerceAppError(value);
}

export function parseWorkspace(value: unknown): Workspace {
  if (isWorkspace(value)) {
    return value;
  }

  throw coerceAppError(value);
}

// ---------------------------------------------------------------------------
// WebSocket message types
// ---------------------------------------------------------------------------
