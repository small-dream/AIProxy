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
    reportCommandFailure("pick_and_read_har_file", error);
    throw coerceAppError(error);
  }
}

/** Output of `pick_and_read_rules_file`: picked file name + JSON contents. */
export interface RulesFileContents {
  fileName: string;
  contents: string;
}

/**
 * Backend-owned picker for a rules-export JSON file (R2), same trust model as
 * `pickAndReadHarFile`. Returns `null` when the user cancels.
 */
export async function pickAndReadRulesFile(title: string): Promise<RulesFileContents | null> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Reading rules files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<RulesFileContents | null>("pick_and_read_rules_file", {
      input: { title },
    });
    return payload ?? null;
  } catch (error) {
    reportCommandFailure("pick_and_read_rules_file", error);
    throw coerceAppError(error);
  }
}

/** Output of `pick_attachment_file`: metadata only, never contents (D1). */
export interface AttachmentFile {
  fileName: string;
  fileToken: string;
  sizeBytes: number;
}

/**
 * Backend-owned attachment picker (C3). Returns the picked file's display
 * metadata and a one-time token; the send path consumes that token server-side.
 * Returns `null` when the user cancels.
 */
export async function pickAttachmentFile(title: string): Promise<AttachmentFile | null> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Attaching files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<AttachmentFile | null>("pick_attachment_file", {
      input: { title },
    });
    return payload ?? null;
  } catch (error) {
    reportCommandFailure("pick_attachment_file", error);
    throw coerceAppError(error);
  }
}

/** How to resolve several captured requests that map to the same target file. */
export type ResponseFileConflictStrategy = "latestOnly" | "keepAll";

/** Summary of a completed `save_response_files` run. */
export interface SaveResponseFilesResult {
  /** The destination as the user picked it (not the canonicalized form used
   *  internally for containment checks, which Windows renders as `\\?\...`). */
  directory: string;
  savedCount: number;
  /** Requests with nothing to save: WebSocket streams, empty bodies, or — under
   *  `latestOnly` — captures superseded by a newer one for the same path. */
  skippedCount: number;
  failedCount: number;
  /** Files written whose captured body was clipped by the capture-size limit —
   *  present on disk but only a prefix of the original response. */
  truncatedCount: number;
}

export interface SaveResponseFilesInput {
  sessionIds: string[];
  conflictStrategy: ResponseFileConflictStrategy;
  /** Localized directory-picker title. */
  title: string;
}

/**
 * Save the captured response body of every given session as a file, rebuilding
 * the full URL path layout under a directory the user picks. The host is not
 * recreated as a directory — the user already chose where the files go.
 *
 * Mirrors the H3 model of `pickAndReadHarFile`: the backend owns the directory
 * picker and derives every path itself, so the renderer never supplies a
 * filesystem location. Bodies are written from the Rust side directly, so
 * binary payloads never round-trip through base64 over IPC.
 *
 * Returns `null` when the user cancels the picker.
 */
export async function saveResponseFiles(
  input: SaveResponseFilesInput,
): Promise<SaveResponseFilesResult | null> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Saving captured files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<SaveResponseFilesResult | null>("save_response_files", {
      input,
    });
    return payload ?? null;
  } catch (error) {
    reportCommandFailure("save_response_files", error);
    throw coerceAppError(error);
  }
}
