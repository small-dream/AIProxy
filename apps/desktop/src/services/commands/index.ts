import { invoke } from "@tauri-apps/api/core";
import {
  coerceAppError,
  createDefaultProxyStatus,
  parseSessionDetail,
  normalizeStartProxyInput,
  parseSessionSummaries,
  parseProxyStatus,
  type ProxyStatus,
  type SessionDetail,
  type SessionSummary,
  type StartProxyInput,
  type StopProxyInput,
} from "@pharles/shared-types";

import {
  logDevDebug,
  logDevError,
  logDevInfo,
} from "@/services/logger/dev-logger";

export async function getBootstrapStatus(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_bootstrap_status_bypassed_non_tauri_runtime");
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "get_bootstrap_status_requested");
    const payload = await invoke<unknown>("get_bootstrap_status");
    const status = parseProxyStatus(payload);

    logDevDebug("ui.commands", "get_bootstrap_status_succeeded", {
      port: status.port,
      running: status.running,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("get_bootstrap_status", error);
    throw coerceAppError(error);
  }
}

export async function startProxy(input: StartProxyInput): Promise<ProxyStatus> {
  const normalizedInput = normalizeStartProxyInput(input);

  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "start_proxy_bypassed_non_tauri_runtime", normalizedInput);
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
    logDevInfo("ui.commands", "start_proxy_requested", normalizedInput);
    const payload = await invoke<unknown>("start_proxy", {
      input: normalizedInput,
    });
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "start_proxy_succeeded", {
      port: status.port,
      running: status.running,
      workspaceId: status.activeWorkspaceId,
    });

    return status;
  } catch (error) {
    reportCommandFailure("start_proxy", error, normalizedInput.workspaceId);
    throw coerceAppError(error);
  }
}

export async function stopProxy(input: StopProxyInput): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "stop_proxy_bypassed_non_tauri_runtime", input);
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "stop_proxy_requested", input);
    const payload = await invoke<unknown>("stop_proxy", { input });
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "stop_proxy_succeeded", {
      running: status.running,
      workspaceId: status.activeWorkspaceId,
    });

    return status;
  } catch (error) {
    reportCommandFailure("stop_proxy", error, input.workspaceId);
    throw coerceAppError(error);
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_sessions_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    logDevDebug("ui.commands", "list_sessions_requested");
    const payload = await invoke<unknown>("list_sessions");
    const sessions = parseSessionSummaries(payload);

    logDevDebug("ui.commands", "list_sessions_succeeded", {
      sessionCount: sessions.length,
    });

    return sessions;
  } catch (error) {
    reportCommandFailure("list_sessions", error);
    throw coerceAppError(error);
  }
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Session detail requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_session_detail_requested", {
      sessionId,
    });
    const payload = await invoke<unknown>("get_session_detail", {
      input: { sessionId },
    });
    const detail = parseSessionDetail(payload);

    logDevDebug("ui.commands", "get_session_detail_succeeded", {
      sessionId: detail.id,
      statusCode: detail.summary.statusCode,
    });

    return detail;
  } catch (error) {
    reportCommandFailure("get_session_detail", error);
    throw coerceAppError(error);
  }
}

export async function enableSystemProxy(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "enable_system_proxy_bypassed_non_tauri_runtime");
    return {
      ...createDefaultProxyStatus(),
      systemProxyEnabled: true,
    };
  }

  try {
    logDevInfo("ui.commands", "enable_system_proxy_requested");
    const payload = await invoke<unknown>("enable_system_proxy");
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "enable_system_proxy_succeeded", {
      port: status.port,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("enable_system_proxy", error);
    throw coerceAppError(error);
  }
}

export async function disableSystemProxy(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "disable_system_proxy_bypassed_non_tauri_runtime");
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "disable_system_proxy_requested");
    const payload = await invoke<unknown>("disable_system_proxy");
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "disable_system_proxy_succeeded", {
      port: status.port,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("disable_system_proxy", error);
    throw coerceAppError(error);
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function reportCommandFailure(commandName: string, error: unknown, workspaceId?: string) {
  logDevError("ui.commands", "command_failed", {
    commandName,
    error,
    occurredAt: new Date().toISOString(),
    workspaceId,
  });
}
