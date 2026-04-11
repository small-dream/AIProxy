export type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

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

export type ProxyStatus = {
  running: boolean;
  port: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  activeWorkspaceId?: string;
  startedAt?: string;
};

export type SessionSummary = {
  id: string;
  method: string;
  host: string;
  path: string;
  protocol: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sizeBytes: number;
  statusCode: number;
  url: string;
};

export type StartProxyInput = {
  workspaceId: string;
  port?: number;
  enableSsl?: boolean;
};

export type StopProxyInput = {
  workspaceId: string;
};

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_PROXY_PORT = 8888;

export function createDefaultProxyStatus(): ProxyStatus {
  return {
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    port: DEFAULT_PROXY_PORT,
    running: false,
    sslEnabled: false,
    systemProxyEnabled: false,
  };
}

const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";
const UNKNOWN_ERROR_MESSAGE = "An unexpected error occurred.";

export function coerceAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: UNKNOWN_ERROR_CODE,
      message: error.message,
    };
  }

  return {
    code: UNKNOWN_ERROR_CODE,
    message: UNKNOWN_ERROR_MESSAGE,
    details: {
      receivedType: typeof error,
    },
  };
}

export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AppError>;

  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export function isProxyStatus(value: unknown): value is ProxyStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ProxyStatus>;

  if (typeof candidate.running !== "boolean") {
    return false;
  }

  if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port <= 0) {
    return false;
  }

  if (typeof candidate.sslEnabled !== "boolean" || typeof candidate.systemProxyEnabled !== "boolean") {
    return false;
  }

  if (candidate.activeWorkspaceId !== undefined && typeof candidate.activeWorkspaceId !== "string") {
    return false;
  }

  if (candidate.startedAt !== undefined && typeof candidate.startedAt !== "string") {
    return false;
  }

  return true;
}

export function parseProxyStatus(value: unknown): ProxyStatus {
  if (isProxyStatus(value)) {
    return value;
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
    enableSsl: input.enableSsl ?? false,
    port: normalizedPort,
    workspaceId: input.workspaceId.trim(),
  };
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionSummary>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.protocol === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.finishedAt === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.statusCode === "number" &&
    typeof candidate.url === "string"
  );
}

export function parseSessionSummaries(value: unknown): SessionSummary[] {
  if (!Array.isArray(value)) {
    throw {
      code: "INVALID_SESSION_SUMMARIES",
      message: "The session list payload must be an array.",
      details: {
        payload: value,
      },
    } satisfies AppError;
  }

  if (value.every(isSessionSummary)) {
    return value;
  }

  throw {
    code: "INVALID_SESSION_SUMMARIES",
    message: "One or more captured sessions do not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}
