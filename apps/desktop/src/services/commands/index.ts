import { invoke } from "@tauri-apps/api/core";
import {
  coerceAppError,
  createDefaultProxyStatus,
  normalizeStartProxyInput,
  parseProxyStatus,
  type ProxyStatus,
  type StartProxyInput,
  type StopProxyInput,
} from "@pharles/shared-types";

export async function getBootstrapStatus(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    return createDefaultProxyStatus();
  }

  try {
    const payload = await invoke<unknown>("get_bootstrap_status");

    return parseProxyStatus(payload);
  } catch (error) {
    reportCommandFailure("get_bootstrap_status", error);
    throw coerceAppError(error);
  }
}

export async function startProxy(input: StartProxyInput): Promise<ProxyStatus> {
  const normalizedInput = normalizeStartProxyInput(input);

  if (!isTauriRuntime()) {
    return {
      ...createDefaultProxyStatus(),
      port: normalizedInput.port ?? createDefaultProxyStatus().port,
      running: true,
      sslEnabled: normalizedInput.enableSsl ?? false,
      startedAt: new Date().toISOString(),
      activeWorkspaceId: normalizedInput.workspaceId,
    };
  }

  try {
    const payload = await invoke<unknown>("start_proxy", {
      input: normalizedInput,
    });

    return parseProxyStatus(payload);
  } catch (error) {
    reportCommandFailure("start_proxy", error, normalizedInput.workspaceId);
    throw coerceAppError(error);
  }
}

export async function stopProxy(input: StopProxyInput): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    return createDefaultProxyStatus();
  }

  try {
    const payload = await invoke<unknown>("stop_proxy", { input });

    return parseProxyStatus(payload);
  } catch (error) {
    reportCommandFailure("stop_proxy", error, input.workspaceId);
    throw coerceAppError(error);
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function reportCommandFailure(commandName: string, error: unknown, workspaceId?: string) {
  console.error("Pharles command failed", {
    commandName,
    error,
    occurredAt: new Date().toISOString(),
    workspaceId,
  });
}
