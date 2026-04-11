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

