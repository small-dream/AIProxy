import { invoke } from "@tauri-apps/api/core";

import { coerceAppError } from "@aiproxy/shared-types";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export async function readHarFile(path: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Reading HAR files requires the Tauri desktop runtime.",
    };
  }

  try {
    return await invoke<string>("read_har_file", {
      input: { path },
    });
  } catch (error) {
    reportCommandFailure("read_har_file", error, path);
    throw coerceAppError(error);
  }
}
