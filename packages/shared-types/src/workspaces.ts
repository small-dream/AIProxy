import { coerceAppError } from "./common";

/** Wire protocol spoken to an upstream (chained) proxy. */
export type UpstreamProxyProtocol = "http" | "https" | "socks5";

export const UPSTREAM_PROXY_PROTOCOLS: readonly UpstreamProxyProtocol[] = [
  "http",
  "https",
  "socks5",
];

/**
 * Upstream (chained) proxy settings for a workspace.
 *
 * When enabled, AIProxy still intercepts and decrypts traffic but delegates the
 * actual egress to this proxy — the typical case being a phone pointed at
 * AIProxy while a local rule-based proxy (Clash, Surge, …) does the routing.
 */
export type UpstreamProxySettings = {
  /** When false the settings are retained but every connection dials directly. */
  enabled: boolean;
  protocol: UpstreamProxyProtocol;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  /**
   * Host patterns that skip the proxy and are dialed directly. Supports exact
   * hostnames, `*.example.com` / `.example.com` suffixes, and CIDR ranges
   * (matched only against literal-IP targets).
   */
  bypass: string[];
};

/** Result of a one-shot upstream proxy connectivity check. */
export type UpstreamProxyProbeResult = {
  success: boolean;
  elapsedMs: number;
  error?: string | null;
  probeTarget: string;
};

export function isUpstreamProxyProtocol(value: unknown): value is UpstreamProxyProtocol {
  return (
    typeof value === "string" &&
    UPSTREAM_PROXY_PROTOCOLS.includes(value as UpstreamProxyProtocol)
  );
}

export function isUpstreamProxySettings(value: unknown): value is UpstreamProxySettings {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<UpstreamProxySettings>;

  return (
    typeof candidate.enabled === "boolean" &&
    isUpstreamProxyProtocol(candidate.protocol) &&
    typeof candidate.host === "string" &&
    typeof candidate.port === "number" &&
    Array.isArray(candidate.bypass) &&
    candidate.bypass.every((entry) => typeof entry === "string")
  );
}

export function parseUpstreamProxyProbeResult(value: unknown): UpstreamProxyProbeResult {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<UpstreamProxyProbeResult>;
    if (
      typeof candidate.success === "boolean" &&
      typeof candidate.elapsedMs === "number" &&
      typeof candidate.probeTarget === "string"
    ) {
      return {
        success: candidate.success,
        elapsedMs: candidate.elapsedMs,
        probeTarget: candidate.probeTarget,
        ...(candidate.error !== null && candidate.error !== undefined
          ? { error: candidate.error }
          : {}),
      };
    }
  }

  throw coerceAppError(value);
}

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
  /**
   * Upstream (chained) proxy settings. Optional: workspaces that never
   * configured one omit the field entirely. Changes take effect on the next
   * proxy start/restart.
   */
  upstreamProxy?: UpstreamProxySettings;
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
