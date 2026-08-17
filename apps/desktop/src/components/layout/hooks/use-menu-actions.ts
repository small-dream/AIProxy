import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { useAppShellStore } from "@/app/store/app-shell.store";
import type { SessionsMenuAction } from "@/features/sessions/session-menu-actions";
import { checkForUpdateAndStore } from "@/features/updater/update-status";
import type { ProxyStatus } from "@aiproxy/shared-types";
import { useI18n } from "@/i18n";
import { onMenuEvent } from "@/services/events";
import { showLogFile } from "@/services/commands";

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
  /** Destructive: clearing all sessions requires confirmation in the shell. */
  onRequestClearAllSessions: () => void;
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
    let cancelled = false;

    onMenuEvent((payload) => {
      handleMenuCommand(payload.menuId);
    }).then((fn) => {
      // If the component unmounted before the listener registered, tear it
      // down immediately so the Tauri menu-event listener does not leak (M8).
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
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
      case "goto_insights":
        h.navigate("/insights");
        break;
      case "goto_compose":
        h.navigate("/compose");
        break;
      case "goto_collections":
        h.navigate("/collections");
        break;
      case "goto_compare":
        h.navigate("/compare");
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
      case "goto_docs":
        h.navigate("/docs");
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
        h.onRequestClearAllSessions();
        break;
      case "find":
        runFindCommand();
        break;
      case "refresh":
        window.location.reload();
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
      case "harmony_quick_actions":
        h.navigate("/certificates?tab=mobile&panel=harmony", {
          state: { menuActionAt: Date.now() },
        });
        break;
      case "check_for_updates": {
        const store = useAppShellStore.getState();
        store.setUpdateDialogOpen(true);
        void checkForUpdateAndStore();
        break;
      }
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
      case "documentation":
        h.navigate("/docs");
        break;
      case "show_logs":
        void showLogFile().catch((error) => {
          h.onSnackbarMessage(getErrorMessage(error, t("common.errors.unexpected")));
        });
        break;
      case "shortcuts":
        h.navigate("/docs?doc=settings&anchor=keyboard-shortcuts");
        break;
      case "edit_undo":
      case "edit_redo":
      case "edit_cut":
      case "edit_copy":
      case "edit_paste":
      case "edit_select_all":
        void runDocumentEditCommand(menuId).catch((error) => {
          h.onSnackbarMessage(getErrorMessage(error, t("common.errors.unexpected")));
        });
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
    const activeElement = document.activeElement;
    const textControl = getEditableTextControl(activeElement);

    if (menuId === "edit_select_all") {
      if (textControl) {
        textControl.select();
        return Promise.resolve();
      }
      const editable = getContentEditableElement(activeElement);
      if (editable) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return Promise.resolve();
    }

    if (menuId === "edit_copy") {
      return copySelection(textControl);
    }

    if (menuId === "edit_cut") {
      return cutSelection(textControl, activeElement);
    }

    if (menuId === "edit_paste") {
      return pasteIntoSelection(textControl, activeElement);
    }

    return Promise.resolve();
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey) return;

      const routeByKey: Record<string, string> = {
        "1": "/",
        "2": "/insights",
        "3": "/compose",
        "4": "/collections",
        "5": "/compare",
        "6": "/rules",
        "7": "/throttling",
        "8": "/certificates",
        "9": "/docs",
        ",": "/settings",
      };
      const route = routeByKey[event.key];
      if (route) {
        event.preventDefault();
        menuHandlerRef.current.navigate(route);
        return;
      }

      if (isEditableEventTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        handleMenuCommand("export_har");
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        handleMenuCommand("clear_all_sessions");
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  return {
    handleMenuCommand,
  };
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(getEditableTextControl(target) || getContentEditableElement(target));
}

function runFindCommand() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
      key: "f",
      metaKey: navigator.platform.toLowerCase().includes("mac"),
    }),
  );

  const windowWithFind = window as Window & { find?: () => boolean };
  windowWithFind.find?.();
}

function getEditableTextControl(element: Element | null) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return null;
  }

  if (element.disabled || element.readOnly) {
    return null;
  }

  if (element instanceof HTMLInputElement) {
    const editableTypes = new Set(["email", "number", "password", "search", "tel", "text", "url"]);
    if (!editableTypes.has(element.type)) {
      return null;
    }
  }

  return element;
}

function getContentEditableElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const editable = element.closest<HTMLElement>("[contenteditable='true']");
  return editable && !editable.getAttribute("aria-disabled") ? editable : null;
}

function getSelectedText(textControl: HTMLInputElement | HTMLTextAreaElement | null) {
  if (textControl) {
    const start = textControl.selectionStart ?? 0;
    const end = textControl.selectionEnd ?? start;
    return textControl.value.slice(start, end);
  }

  return window.getSelection()?.toString() ?? "";
}

async function copySelection(textControl: HTMLInputElement | HTMLTextAreaElement | null) {
  const selectedText = getSelectedText(textControl);
  if (selectedText) {
    await navigator.clipboard?.writeText(selectedText);
  }
}

async function cutSelection(
  textControl: HTMLInputElement | HTMLTextAreaElement | null,
  activeElement: Element | null,
) {
  const selectedText = getSelectedText(textControl);
  if (!selectedText) return;

  await navigator.clipboard?.writeText(selectedText);

  if (textControl) {
    textControl.setRangeText("", textControl.selectionStart ?? 0, textControl.selectionEnd ?? 0);
    textControl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
    return;
  }

  if (getContentEditableElement(activeElement)) {
    window.getSelection()?.deleteFromDocument();
  }
}

async function pasteIntoSelection(
  textControl: HTMLInputElement | HTMLTextAreaElement | null,
  activeElement: Element | null,
) {
  const text = await navigator.clipboard?.readText();
  if (!text) return;

  if (textControl) {
    const start = textControl.selectionStart ?? textControl.value.length;
    const end = textControl.selectionEnd ?? start;
    textControl.setRangeText(text, start, end, "end");
    textControl.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertFromPaste" }),
    );
    return;
  }

  if (!getContentEditableElement(activeElement)) {
    return;
  }

  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) return;

  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
}
