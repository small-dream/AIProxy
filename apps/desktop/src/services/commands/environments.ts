import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseApiEnvironments,
  parseApiEnvironmentVariables,
  parseApiGlobalVariables,
  type ApiEnvironment,
  type ApiEnvironmentVariable,
  type ApiGlobalVariable,
} from "@aiproxy/shared-types";

import {
  isTauriRuntime,
  reportCommandFailure,
} from "./runtime";

export async function listApiEnvironments(): Promise<ApiEnvironment[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_environments");
    return parseApiEnvironments(payload);
  } catch (error) {
    reportCommandFailure("list_api_environments", error);
    throw coerceAppError(error);
  }
}

export async function upsertApiEnvironment(input: {
  id?: string;
  name: string;
  sortOrder?: number;
}): Promise<ApiEnvironment> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_environment", { input });
    const envs = parseApiEnvironments([payload]);
    const result = envs[0];
    if (!result) throw coerceAppError("Empty response");
    return result;
  } catch (error) {
    reportCommandFailure("upsert_api_environment", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiEnvironment(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_environment", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_environment", error, id);
    throw coerceAppError(error);
  }
}

export async function listApiEnvironmentVariables(
  environmentId: string,
): Promise<ApiEnvironmentVariable[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_environment_variables", {
      input: { environmentId },
    });
    return parseApiEnvironmentVariables(payload);
  } catch (error) {
    reportCommandFailure("list_api_environment_variables", error, environmentId);
    throw coerceAppError(error);
  }
}

export async function setApiEnvironmentVariables(
  environmentId: string,
  variables: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    sortOrder?: number;
  }>,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_api_environment_variables", {
      input: { environmentId, variables },
    });
  } catch (error) {
    reportCommandFailure("set_api_environment_variables", error, environmentId);
    throw coerceAppError(error);
  }
}

export async function listApiGlobalVariables(): Promise<ApiGlobalVariable[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_global_variables");
    return parseApiGlobalVariables(payload);
  } catch (error) {
    reportCommandFailure("list_api_global_variables", error);
    throw coerceAppError(error);
  }
}

export async function setApiGlobalVariables(
  variables: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    sortOrder?: number;
  }>,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_api_global_variables", {
      input: { variables },
    });
  } catch (error) {
    reportCommandFailure("set_api_global_variables", error);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// Batch execute
// ---------------------------------------------------------------------------
