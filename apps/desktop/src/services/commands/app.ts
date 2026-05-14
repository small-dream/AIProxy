import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseAppBuildInfo,
  type AppBuildInfo,
} from "@aiproxy/shared-types";

import { logDevDebug } from "@/services/logger/dev-logger";

import {
  isTauriRuntime,
  reportCommandFailure,
} from "./runtime";

const fallbackAppBuildInfo: AppBuildInfo = {
  version: "0.1.0",
  buildNumber: "0",
  versionIdentifier: "0.1.0+0",
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
