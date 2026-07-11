import { invoke } from "@tauri-apps/api/core";

import { coerceAppError } from "@aiproxy/shared-types";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

/** Output of `pick_and_read_har_file`: the picked file name + HAR contents. */
export interface HarFileContents {
  fileName: string;
  contents: string;
}

/**
 * H3: the backend owns the file dialog. The renderer supplies only a localized
 * dialog title; the Rust side drives the OS file picker and returns the picked
 * file's contents. This closes the arbitrary-file-read primitive that the old
 * `read_har_file(path)` exposed under the compromised-renderer threat model.
 * Returns `null` when the user cancels the dialog.
 */
export async function pickAndReadHarFile(title: string): Promise<HarFileContents | null> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Reading HAR files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<HarFileContents | null>("pick_and_read_har_file", {
      input: { title },
    });
    return payload ?? null;
  } catch (error) {
    reportCommandFailure("pick_and_read_har_file", error, title);
    throw coerceAppError(error);
  }
}
