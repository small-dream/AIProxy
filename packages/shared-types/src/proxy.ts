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
    candidate.port <= 0
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
