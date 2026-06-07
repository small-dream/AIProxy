import { getCurrentWindow } from "@tauri-apps/api/window";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Provides window management commands (minimize, maximize, fullscreen, close).
 * No-ops outside of Tauri runtime.
 */
export function useWindowControls() {
  async function runWindowCommand(menuId: string) {
    if (!isTauriRuntime()) {
      return;
    }

    const currentWindow = getCurrentWindow();

    switch (menuId) {
      case "window_minimize":
        await currentWindow.minimize();
        break;
      case "window_toggle_maximize":
        await currentWindow.toggleMaximize();
        break;
      case "window_toggle_fullscreen":
        await currentWindow.setFullscreen(!(await currentWindow.isFullscreen()));
        break;
      case "window_close":
        await currentWindow.close();
        break;
    }
  }

  return { runWindowCommand };
}
