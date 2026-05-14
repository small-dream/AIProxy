import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseAiSettingsPublic,
  parseSessionDiffSummaryResult,
  parseTestAiConnectionResult,
  type AiSettingsPublic,
  type SaveAiSettingsInput,
  type SessionDiffSummaryRequest,
  type SessionDiffSummaryResult,
  type TestAiConnectionResult,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";
import { isTauriRuntime, reportCommandFailure } from "./runtime";

const fallbackAiSettings: AiSettingsPublic = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  hasApiKey: false,
  temperature: 0.2,
  timeoutMs: 30_000,
};

export async function getAiSettings(): Promise<AiSettingsPublic> {
  if (!isTauriRuntime()) {
    return fallbackAiSettings;
  }

  try {
    logDevDebug("ui.commands", "get_ai_settings_requested");
    return parseAiSettingsPublic(await invoke<unknown>("get_ai_settings"));
  } catch (error) {
    reportCommandFailure("get_ai_settings", error);
    throw coerceAppError(error);
  }
}

export async function saveAiSettings(input: SaveAiSettingsInput): Promise<AiSettingsPublic> {
  if (!isTauriRuntime()) {
    return {
      ...fallbackAiSettings,
      baseUrl: input.baseUrl,
      model: input.model,
      provider: input.provider,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
      hasApiKey: Boolean(input.apiKey?.trim()) && !input.clearApiKey,
      maskedApiKey: input.apiKey?.trim() ? "**** local" : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    logDevInfo("ui.commands", "save_ai_settings_requested", {
      baseUrl: input.baseUrl,
      model: input.model,
      provider: input.provider,
    });
    return parseAiSettingsPublic(await invoke<unknown>("save_ai_settings", { input }));
  } catch (error) {
    reportCommandFailure("save_ai_settings", error);
    throw coerceAppError(error);
  }
}

export async function testAiConnection(): Promise<TestAiConnectionResult> {
  if (!isTauriRuntime()) {
    return { ok: false, message: "AI connection tests require the Tauri desktop runtime." };
  }

  try {
    logDevInfo("ui.commands", "test_ai_connection_requested");
    return parseTestAiConnectionResult(await invoke<unknown>("test_ai_connection"));
  } catch (error) {
    reportCommandFailure("test_ai_connection", error);
    throw coerceAppError(error);
  }
}

export async function summarizeSessionDiff(
  input: SessionDiffSummaryRequest,
): Promise<SessionDiffSummaryResult> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "AI summaries require the Tauri desktop runtime.",
    };
  }

  try {
    logDevInfo("ui.commands", "summarize_session_diff_requested", {
      bodyIncluded: input.payload.bodyIncluded,
      language: input.language,
      sectionCount: input.payload.sections.length,
    });
    return parseSessionDiffSummaryResult(await invoke<unknown>("summarize_session_diff", { input }));
  } catch (error) {
    reportCommandFailure("summarize_session_diff", error);
    throw coerceAppError(error);
  }
}
