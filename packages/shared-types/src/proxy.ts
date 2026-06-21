import { AppError, DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "./common";

export type ProxyStatus = {
  running: boolean;
  port: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  http2Enabled?: boolean;
  activeWorkspaceId?: string;
  startedAt?: string;
  systemProxyRecoveryWarning?: string;
};

export type StartProxyInput = {
  workspaceId: string;
  port?: number;
  enableSsl?: boolean;
  enableHttp2?: boolean;
};

export type StopProxyInput = {
  workspaceId: string;
};

export function createDefaultProxyStatus(): ProxyStatus {
  return {
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    port: DEFAULT_PROXY_PORT,
    running: false,
    sslEnabled: true,
    systemProxyEnabled: false,
  };
}

export function isProxyStatus(value: unknown): value is ProxyStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ProxyStatus> & {
    activeWorkspaceId?: string | null;
    startedAt?: string | null;
  };

  if (typeof candidate.running !== "boolean") {
    return false;
  }

  if (
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port <= 0 ||
    candidate.port > 65535
  ) {
    return false;
  }

  if (
    typeof candidate.sslEnabled !== "boolean" ||
    typeof candidate.systemProxyEnabled !== "boolean"
  ) {
    return false;
  }

  if (
    candidate.activeWorkspaceId !== undefined &&
    candidate.activeWorkspaceId !== null &&
    typeof candidate.activeWorkspaceId !== "string"
  ) {
    return false;
  }

  if (
    candidate.startedAt !== undefined &&
    candidate.startedAt !== null &&
    typeof candidate.startedAt !== "string"
  ) {
    return false;
  }

  if (
    candidate.systemProxyRecoveryWarning !== undefined &&
    candidate.systemProxyRecoveryWarning !== null &&
    typeof candidate.systemProxyRecoveryWarning !== "string"
  ) {
    return false;
  }

  return true;
}

export function parseProxyStatus(value: unknown): ProxyStatus {
  if (isProxyStatus(value)) {
    const candidate = value as ProxyStatus & {
      activeWorkspaceId?: string | null;
      startedAt?: string | null;
      http2Enabled?: boolean | null;
    };

    return {
      port: candidate.port,
      running: candidate.running,
      sslEnabled: candidate.sslEnabled,
      systemProxyEnabled: candidate.systemProxyEnabled,
      ...(candidate.activeWorkspaceId !== null && candidate.activeWorkspaceId !== undefined
        ? { activeWorkspaceId: candidate.activeWorkspaceId }
        : {}),
      ...(candidate.startedAt !== null && candidate.startedAt !== undefined
        ? { startedAt: candidate.startedAt }
        : {}),
      ...(candidate.systemProxyRecoveryWarning !== null &&
      candidate.systemProxyRecoveryWarning !== undefined
        ? { systemProxyRecoveryWarning: candidate.systemProxyRecoveryWarning }
        : {}),
      ...(candidate.http2Enabled !== null && candidate.http2Enabled !== undefined
        ? { http2Enabled: candidate.http2Enabled }
        : {}),
    };
  }

  throw {
    code: "INVALID_PROXY_STATUS",
    message: "The proxy status payload does not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function normalizeStartProxyInput(input: StartProxyInput): StartProxyInput {
  const normalizedPort = input.port ?? DEFAULT_PROXY_PORT;

  return {
    enableSsl: input.enableSsl ?? true,
    enableHttp2: input.enableHttp2 ?? true,
    port: normalizedPort,
    workspaceId: input.workspaceId.trim(),
  };
}

// --- Port occupant (for the "end the process holding the proxy port" flow) ---

export type PortOccupant = {
  pid: number;
  name: string;
};

export type KillPortProcessInput = {
  port: number;
  pid: number;
  name?: string;
};

export function isPortOccupant(value: unknown): value is PortOccupant {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PortOccupant>;

  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0
  );
}

// Defensive parser for the Tauri `get_port_occupant` payload: returns null for
// malformed data so the UI never trusts an anomalous pid/name.
export function parsePortOccupant(value: unknown): PortOccupant | null {
  if (!isPortOccupant(value)) {
    return null;
  }

  const candidate = value as PortOccupant;

  return { pid: candidate.pid, name: candidate.name };
}
