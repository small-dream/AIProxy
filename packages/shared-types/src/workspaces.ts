import { coerceAppError } from "./common";

export type Workspace = {
  id: string;
  name: string;
  proxyPort: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  http2Enabled?: boolean;
  /**
   * H3: when true the proxy verifies upstream TLS certificates against the OS
   * root store on new HTTPS/WSS connections. Optional for backward
   * compatibility with older persisted state (defaults to false = NoOp
   * verifier, the historical debug-proxy behavior).
   */
  verifyUpstreamTls?: boolean;
  /**
   * H3: hostnames always TLS-verified even when `verifyUpstreamTls` is false
   * (an allowlist of "verify these hosts regardless"). Optional for backward
   * compatibility (defaults to an empty array).
   */
  tlsVerifyHosts?: string[];
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
