import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseInsightsResult,
  parseSessionDetailContentPatch,
  parseSessionDetail,
  mergeSessionDetailContent,
  parseSessionSummaries,
  type InsightsResult,
  type GetInsightsInput,
  type SessionDetail,
  type SessionDetailContentPatch,
  type SessionDetailContentRequest,
  type SessionSummary,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo, logDevWarn } from "@/services/logger/dev-logger";

import {
  clearImportedSessions,
  getImportedSessionDetail,
  keepOnlyImportedSession,
  listImportedSessionSummaries,
} from "@/features/sessions/imported-sessions.store";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export async function listSessions(): Promise<SessionSummary[]> {
  const importedSessions = listImportedSessionSummaries();

  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_sessions_bypassed_non_tauri_runtime");
    return importedSessions;
  }

  try {
    logDevDebug("ui.commands", "list_sessions_requested");
    const payload = await invoke<unknown>("list_sessions");
    const sessions = mergeImportedSessionSummaries(
      parseSessionSummaries(payload),
      importedSessions,
    );

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
  const importedDetail = getImportedSessionDetail(sessionId);

  if (importedDetail) {
    return importedDetail;
  }

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
    const appError = coerceAppError(error);
    if (isCapturedSessionNotFoundError(appError)) {
      logDevWarn("ui.commands", "session_detail_not_found", {
        commandName: "get_session_detail",
        errorCode: appError.code,
        message: appError.message,
        sessionId,
      });
    } else {
      reportCommandFailure("get_session_detail", error);
    }
    throw appError;
  }
}

export async function getSessionDetailContent(
  input: SessionDetailContentRequest,
): Promise<SessionDetailContentPatch> {
  const importedDetail = getImportedSessionDetail(input.sessionId);

  if (importedDetail) {
    return {
      sessionId: input.sessionId,
      ...(input.includeRawRequest && importedDetail.rawRequest !== undefined
        ? { rawRequest: importedDetail.rawRequest }
        : {}),
      ...(input.includeRawRequest && importedDetail.rawRequestDeferred !== undefined
        ? { rawRequestDeferred: importedDetail.rawRequestDeferred }
        : {}),
      ...(input.includeRawResponse && importedDetail.rawResponse !== undefined
        ? { rawResponse: importedDetail.rawResponse }
        : {}),
      ...(input.includeRawResponse && importedDetail.rawResponseDeferred !== undefined
        ? { rawResponseDeferred: importedDetail.rawResponseDeferred }
        : {}),
      ...(input.includeRequestBodyText || input.includeRequestBodyBase64
        ? {
            requestBody: {
              ...(input.includeRequestBodyText &&
              importedDetail.requestBody?.inlineText !== undefined
                ? { inlineText: importedDetail.requestBody.inlineText }
                : {}),
              ...(input.includeRequestBodyText &&
              importedDetail.requestBody?.textDeferred !== undefined
                ? { textDeferred: importedDetail.requestBody.textDeferred }
                : {}),
              ...(input.includeRequestBodyBase64 &&
              importedDetail.requestBody?.base64Text !== undefined
                ? { base64Text: importedDetail.requestBody.base64Text }
                : {}),
              ...(input.includeRequestBodyBase64 &&
              importedDetail.requestBody?.base64Deferred !== undefined
                ? { base64Deferred: importedDetail.requestBody.base64Deferred }
                : {}),
            },
          }
        : {}),
      ...(input.includeResponseBodyText || input.includeResponseBodyBase64
        ? {
            responseBody: {
              ...(input.includeResponseBodyText &&
              importedDetail.responseBody?.inlineText !== undefined
                ? { inlineText: importedDetail.responseBody.inlineText }
                : {}),
              ...(input.includeResponseBodyText &&
              importedDetail.responseBody?.textDeferred !== undefined
                ? { textDeferred: importedDetail.responseBody.textDeferred }
                : {}),
              ...(input.includeResponseBodyBase64 &&
              importedDetail.responseBody?.base64Text !== undefined
                ? { base64Text: importedDetail.responseBody.base64Text }
                : {}),
              ...(input.includeResponseBodyBase64 &&
              importedDetail.responseBody?.base64Deferred !== undefined
                ? { base64Deferred: importedDetail.responseBody.base64Deferred }
                : {}),
            },
          }
        : {}),
    };
  }

  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Session detail content requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_session_detail_content_requested", input);
    const payload = await invoke<unknown>("get_session_detail_content", {
      input,
    });
    const patch = parseSessionDetailContentPatch(payload);

    logDevDebug("ui.commands", "get_session_detail_content_succeeded", {
      sessionId: patch.sessionId,
    });

    return patch;
  } catch (error) {
    const appError = coerceAppError(error);
    if (isCapturedSessionNotFoundError(appError)) {
      logDevWarn("ui.commands", "session_detail_not_found", {
        commandName: "get_session_detail_content",
        errorCode: appError.code,
        message: appError.message,
        request: input,
        sessionId: input.sessionId,
      });
    } else {
      reportCommandFailure("get_session_detail_content", error);
    }
    throw appError;
  }
}

export function isCapturedSessionNotFoundError(error: unknown): boolean {
  return coerceAppError(error).code === "SESSION_NOT_FOUND";
}

export async function getSessionDetailWithContent(
  sessionId: string,
  contentRequest: Omit<SessionDetailContentRequest, "sessionId">,
): Promise<SessionDetail> {
  const detail = await getSessionDetail(sessionId);
  const patch = await getSessionDetailContent({
    sessionId,
    ...contentRequest,
  });

  return mergeSessionDetailContent(detail, patch);
}

export async function clearSessions(): Promise<void> {
  clearImportedSessions();

  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "clear_sessions_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "clear_sessions_requested");
    await invoke("clear_sessions");
    logDevInfo("ui.commands", "clear_sessions_succeeded");
  } catch (error) {
    reportCommandFailure("clear_sessions", error);
    throw coerceAppError(error);
  }
}

export async function deleteSessionsExcept(keepSessionId: string): Promise<void> {
  keepOnlyImportedSession(keepSessionId);

  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "delete_sessions_except_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "delete_sessions_except_requested", { keepSessionId });
    await invoke("delete_sessions_except", {
      input: { keepSessionId },
    });
    logDevInfo("ui.commands", "delete_sessions_except_succeeded");
  } catch (error) {
    reportCommandFailure("delete_sessions_except", error);
    throw coerceAppError(error);
  }
}

function mergeImportedSessionSummaries(
  sessions: SessionSummary[],
  importedSessions: SessionSummary[],
): SessionSummary[] {
  if (importedSessions.length === 0) {
    return sessions;
  }

  const sessionsById = new Map<string, SessionSummary>();

  for (const session of sessions) {
    sessionsById.set(session.id, session);
  }

  for (const importedSession of importedSessions) {
    sessionsById.set(importedSession.id, importedSession);
  }

  return Array.from(sessionsById.values());
}

export async function setFocusedHosts(hosts: string[]): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_focused_hosts_bypassed_non_tauri_runtime", { hosts });
    return;
  }

  try {
    logDevDebug("ui.commands", "set_focused_hosts_requested", { hosts });
    await invoke("set_focused_hosts", {
      input: { hosts },
    });
    logDevDebug("ui.commands", "set_focused_hosts_succeeded", { hosts });
  } catch (error) {
    reportCommandFailure("set_focused_hosts", error);
    throw coerceAppError(error);
  }
}

export async function invokeGetInsights(input: GetInsightsInput): Promise<InsightsResult> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Insights requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_insights_requested", {
      excludedHosts: input.excludedHosts,
      hostExact: input.hostExact,
      sessionCount: input.sessionIds.length,
      hostKeyword: input.hostKeyword,
    });
    const payload = await invoke<unknown>("get_insights", { input });
    const result = parseInsightsResult(payload);

    logDevDebug("ui.commands", "get_insights_succeeded", {
      totalRequests: result.totalRequests,
    });

    return result;
  } catch (error) {
    reportCommandFailure("get_insights", error);
    throw coerceAppError(error);
  }
}
