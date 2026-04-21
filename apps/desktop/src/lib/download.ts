import { invoke } from "@tauri-apps/api/core";

type DownloadTextFileOptions = {
  revealInFolder?: boolean;
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
  options: DownloadTextFileOptions = {},
) {
  if (isTauriRuntime()) {
    await invoke("save_text_file", {
      input: {
        content,
        fileName: filename,
        revealInFolder: options.revealInFolder ?? false,
      },
    });
    return;
  }

  const blob = new Blob([content], { type: mimeType });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}
