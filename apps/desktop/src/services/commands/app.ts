import { invoke } from "@tauri-apps/api/core";

import { coerceAppError, parseAppBuildInfo, type AppBuildInfo } from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

const fallbackAppBuildInfo: AppBuildInfo = {
  version: "0.1.0",
  buildNumber: "0",
  versionIdentifier: "0.1.0+0",
  commitHash: "dev",
};

export async function getAppBuildInfo(): Promise<AppBuildInfo> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_app_build_info_bypassed_non_tauri_runtime");
    return fallbackAppBuildInfo;
  }

  try {
    logDevDebug("ui.commands", "get_app_build_info_requested");
    return parseAppBuildInfo(await invoke<unknown>("get_app_build_info"));
  } catch (error) {
    reportCommandFailure("get_app_build_info", error);
    throw coerceAppError(error);
  }
}

export async function showLogFile(): Promise<string> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "show_log_file_bypassed_non_tauri_runtime");
    return "";
  }

  try {
    logDevInfo("ui.commands", "show_log_file_requested");
    const logFile = await invoke<string>("show_log_file");
    logDevInfo("ui.commands", "show_log_file_succeeded", { logFile });
    return logFile;
  } catch (error) {
    reportCommandFailure("show_log_file", error);
    throw coerceAppError(error);
  }
}
