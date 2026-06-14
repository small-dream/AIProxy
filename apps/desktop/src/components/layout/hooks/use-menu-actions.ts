import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import type { SessionsMenuAction } from "@/features/sessions/session-menu-actions";
import type { ProxyStatus } from "@aiproxy/shared-types";
import { useI18n } from "@/i18n";
import { onMenuEvent } from "@/services/events";
import { clearSessions, showLogFile } from "@/services/commands";

import { getErrorMessage } from "./helpers";

interface MenuHandlerDeps {
  navigate: NavigateFunction;
  proxyStatus: ProxyStatus | undefined;
  handleStartProxy: (input?: {
    enableSsl: boolean;
    port: number;
    workspaceId: string;
  }) => Promise<void>;
  handleStopProxy: () => Promise<void>;
  handleSystemProxyToggle: () => Promise<void>;
  handleAdbSetProxy: () => Promise<void>;
  handleAdbClearProxy: () => Promise<void>;
  runWindowCommand: (menuId: string) => Promise<void>;
  onSnackbarMessage: (message: string | null) => void;
}

/**
 * Manages the menu bar event handling.
 * Uses a ref-based pattern to always read the latest handler closures
 * without re-registering the event listener.
 */
export function useMenuActions(deps: MenuHandlerDeps) {
  const { t } = useI18n();
  const setThemePreference = useAppPreferencesStore((s) => s.setThemePreference);

  const menuHandlerRef = useRef({
    ...deps,
    setThemePreference,
  });

  useEffect(() => {
    menuHandlerRef.current = {
      ...deps,
      setThemePreference,
    };
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onMenuEvent((payload) => {
      handleMenuCommand(payload.menuId);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads latest handlers via menuHandlerRef
  }, []);

  function handleMenuCommand(menuId: string) {
    const h = menuHandlerRef.current;
    const navigateToSessionsMenuAction = (menuAction: SessionsMenuAction) => {
      h.navigate("/", {
        state: {
          sessionsMenuAction: menuAction,
        },
      });
    };

    switch (menuId) {
      case "preferences":
        h.navigate("/settings");
        break;
      case "goto_sessions":
        h.navigate("/");
        break;
      case "goto_compose":
        h.navigate("/compose");
        break;
      case "goto_rules":
        h.navigate("/rules");
        break;
      case "goto_throttling":
        h.navigate("/throttling");
        break;
      case "goto_certificates":
        h.navigate("/certificates");
        break;
      case "goto_settings":
        h.navigate("/settings");
        break;
      case "theme_dark":
        h.setThemePreference("dark");
        break;
      case "theme_light":
        h.setThemePreference("light");
        break;
      case "theme_system":
        h.setThemePreference("system");
        break;
      case "start_proxy":
        if (!h.proxyStatus?.running) {
          void h.handleStartProxy();
        }
        break;
      case "stop_proxy":
        if (h.proxyStatus?.running) {
          void h.handleStopProxy();
        }
        break;
      case "toggle_system_proxy":
        void h.handleSystemProxyToggle();
        break;
      case "clear_sessions":
      case "clear_all_sessions":
        void clearSessions();
        break;
      case "find":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-find"));
        break;
      case "refresh":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-refresh"));
        break;
      case "zoom_in":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-zoom-in"));
        break;
      case "zoom_out":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-zoom-out"));
        break;
      case "zoom_reset":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-zoom-reset"));
        break;
      case "breakpoint_rules":
        h.navigate("/rules");
        break;
      case "throttling_tool":
        h.navigate("/throttling");
        break;
      case "install_cert":
        h.navigate("/certificates");
        break;
      case "cert_status":
        h.navigate("/certificates");
        break;
      case "ios_quick_actions":
        h.navigate("/certificates?tab=mobile&panel=ios", {
          state: { menuActionAt: Date.now() },
        });
        break;
      case "android_quick_actions":
        h.navigate("/certificates?tab=mobile&panel=android", {
          state: { menuActionAt: Date.now() },
        });
        break;
      case "adb_set_proxy":
        void h.handleAdbSetProxy();
        break;
      case "adb_clear_proxy":
        void h.handleAdbClearProxy();
        break;
      case "check_for_updates":
        h.navigate("/settings");
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("aiproxy-check-for-updates"));
        }, 0);
        break;
      case "import_har":
        navigateToSessionsMenuAction({
          kind: "import-har",
          requestedAt: Date.now(),
        });
        break;
      case "export_har":
        navigateToSessionsMenuAction({
          format: "har",
          kind: "export",
          requestedAt: Date.now(),
        });
        break;
      case "setup_wizard":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-setup-wizard"));
        break;
      case "documentation": {
        const docsUrl = "https://github.com/jakejiang/aiproxy";
        window.open(docsUrl, "_blank");
        break;
      }
      case "show_logs":
        void showLogFile().catch((error) => {
          h.onSnackbarMessage(getErrorMessage(error, t("common.errors.unexpected")));
        });
        break;
      case "shortcuts":
        window.dispatchEvent(new CustomEvent("aiproxy-menu-shortcuts"));
        break;
      case "edit_undo":
      case "edit_redo":
      case "edit_cut":
      case "edit_copy":
      case "edit_paste":
      case "edit_select_all":
        runDocumentEditCommand(menuId);
        break;
      case "window_minimize":
      case "window_toggle_maximize":
      case "window_toggle_fullscreen":
      case "window_close":
        void h.runWindowCommand(menuId);
        break;
    }
  }

  function runDocumentEditCommand(menuId: string) {
    const commandByMenuId: Record<string, string> = {
      edit_copy: "copy",
      edit_cut: "cut",
      edit_paste: "paste",
      edit_redo: "redo",
      edit_select_all: "selectAll",
      edit_undo: "undo",
    };
    const command = commandByMenuId[menuId];

    if (command) {
      document.execCommand(command);
    }
  }

  return {
    handleMenuCommand,
  };
}
