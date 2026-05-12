import { coerceAppError } from "./common";

export type ApiEnvironment = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ApiEnvironmentVariable = {
  id: string;
  environmentId: string;
  key: string;
  value: string;
  enabled: boolean;
  sortOrder: number;
};

export type ApiGlobalVariable = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  sortOrder: number;
};

export function isApiEnvironment(value: unknown): value is ApiEnvironment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiEnvironment>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.sortOrder === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function parseApiEnvironments(value: unknown): ApiEnvironment[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isApiEnvironment)) return value;
  throw coerceAppError(value);
}

export function isApiEnvironmentVariable(value: unknown): value is ApiEnvironmentVariable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiEnvironmentVariable>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.environmentId === "string" &&
    typeof candidate.key === "string" &&
    typeof candidate.value === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.sortOrder === "number"
  );
}

export function parseApiEnvironmentVariables(value: unknown): ApiEnvironmentVariable[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isApiEnvironmentVariable)) return value;
  throw coerceAppError(value);
}

export function isApiGlobalVariable(value: unknown): value is ApiGlobalVariable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiGlobalVariable>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.key === "string" &&
    typeof candidate.value === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.sortOrder === "number"
  );
}

export function parseApiGlobalVariables(value: unknown): ApiGlobalVariable[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isApiGlobalVariable)) return value;
  throw coerceAppError(value);
}
