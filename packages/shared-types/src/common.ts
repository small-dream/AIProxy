export type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_PROXY_PORT = 8888;

const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";
const UNKNOWN_ERROR_MESSAGE = "An unexpected error occurred.";

export function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

export function isNullableBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

export function coerceAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (typeof error === "string") {
    const trimmedError = error.trim();

    if (trimmedError.length === 0) {
      return {
        code: UNKNOWN_ERROR_CODE,
        message: UNKNOWN_ERROR_MESSAGE,
      };
    }

    try {
      const parsedError = JSON.parse(trimmedError);

      if (isAppError(parsedError)) {
        return parsedError;
      }
    } catch {
      // Fall back to the raw string when the payload is not JSON.
    }

    return {
      code: UNKNOWN_ERROR_CODE,
      message: trimmedError,
    };
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
