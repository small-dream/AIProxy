import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  createMockComposeSessionDetail,
  parseSessionDetail,
  type ComposedRequestInput,
  type SessionDetail,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

// Log only the origin + path: the query string can carry tokens/credentials
// and the dev log is a plain-text file.
function describeUrlForLog(url: string): { host?: string; path?: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    // Not a parseable absolute URL — log nothing rather than the raw string.
    return {};
  }
}

export async function sendComposedRequest(input: ComposedRequestInput): Promise<SessionDetail> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "send_composed_request_bypassed_non_tauri_runtime");
    return createMockComposeSessionDetail(input);
  }

  try {
    logDevInfo("ui.commands", "send_composed_request_requested", {
      ...describeUrlForLog(input.url),
      method: input.method,
    });
    const payload = await invoke<unknown>("send_composed_request", { input });
    const detail = parseSessionDetail(payload);

    logDevInfo("ui.commands", "send_composed_request_succeeded", {
      sessionId: detail.id,
      statusCode: detail.summary.statusCode,
    });

    return detail;
  } catch (error) {
    reportCommandFailure("send_composed_request", error);
    throw coerceAppError(error);
  }
}
