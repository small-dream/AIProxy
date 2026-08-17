import type { TranslationKey } from "@/i18n";

type WindowsMenuCommandItem = {
  accelerator?: string;
  disabled?: boolean;
  id: string;
  labelKey: TranslationKey;
};

type WindowsMenuDividerItem = {
  kind: "divider";
};

type WindowsMenuDefinition = {
  id: string;
  labelKey: TranslationKey;
  items: readonly (WindowsMenuCommandItem | WindowsMenuDividerItem)[];
};

export const WINDOWS_MENU_DEFINITIONS: readonly WindowsMenuDefinition[] = [
  {
    id: "file",
    labelKey: "appShell.windowsMenu.file",
    items: [
      { id: "import_har", labelKey: "appShell.windowsMenu.importHar" },
      { kind: "divider" },
      { id: "export_har", labelKey: "appShell.windowsMenu.exportHar", accelerator: "Ctrl+E" },
      { kind: "divider" },
      {
        id: "clear_all_sessions",
        labelKey: "appShell.windowsMenu.clearAllSessions",
        accelerator: "Ctrl+L",
      },
    ],
  },
  {
    id: "edit",
    labelKey: "appShell.windowsMenu.edit",
    items: [
      {
        id: "edit_undo",
        labelKey: "appShell.windowsMenu.undo",
        accelerator: "Ctrl+Z",
        disabled: true,
      },
      {
        id: "edit_redo",
        labelKey: "appShell.windowsMenu.redo",
        accelerator: "Ctrl+Y",
        disabled: true,
      },
      { kind: "divider" },
      { id: "edit_cut", labelKey: "appShell.windowsMenu.cut", accelerator: "Ctrl+X" },
      { id: "edit_copy", labelKey: "appShell.windowsMenu.copy", accelerator: "Ctrl+C" },
      { id: "edit_paste", labelKey: "appShell.windowsMenu.paste", accelerator: "Ctrl+V" },
      {
        id: "edit_select_all",
        labelKey: "appShell.windowsMenu.selectAll",
        accelerator: "Ctrl+A",
      },
      { kind: "divider" },
      { id: "find", labelKey: "appShell.windowsMenu.find", accelerator: "Ctrl+F" },
    ],
  },
  {
    id: "view",
    labelKey: "appShell.windowsMenu.view",
    items: [
      { id: "refresh", labelKey: "appShell.windowsMenu.refresh", accelerator: "Ctrl+R" },
      { kind: "divider" },
      { id: "goto_sessions", labelKey: "navigation.sessions", accelerator: "Ctrl+1" },
      { id: "goto_insights", labelKey: "navigation.insights", accelerator: "Ctrl+2" },
      { id: "goto_compose", labelKey: "navigation.compose", accelerator: "Ctrl+3" },
      { id: "goto_collections", labelKey: "navigation.collections", accelerator: "Ctrl+4" },
      { id: "goto_compare", labelKey: "navigation.compare", accelerator: "Ctrl+5" },
      { id: "goto_rules", labelKey: "navigation.rules", accelerator: "Ctrl+6" },
      { id: "goto_throttling", labelKey: "navigation.throttling", accelerator: "Ctrl+7" },
      { id: "goto_certificates", labelKey: "navigation.certificates", accelerator: "Ctrl+8" },
      { id: "goto_docs", labelKey: "navigation.docs", accelerator: "Ctrl+9" },
      { id: "goto_settings", labelKey: "navigation.settings", accelerator: "Ctrl+," },
      { kind: "divider" },
      { id: "zoom_in", labelKey: "appShell.windowsMenu.zoomIn", accelerator: "Ctrl++" },
      { id: "zoom_out", labelKey: "appShell.windowsMenu.zoomOut", accelerator: "Ctrl+-" },
      { id: "zoom_reset", labelKey: "appShell.windowsMenu.resetZoom", accelerator: "Ctrl+0" },
      { kind: "divider" },
      { id: "theme_dark", labelKey: "appShell.windowsMenu.darkTheme" },
      { id: "theme_light", labelKey: "appShell.windowsMenu.lightTheme" },
      { id: "theme_system", labelKey: "appShell.windowsMenu.systemTheme" },
    ],
  },
  {
    id: "proxy",
    labelKey: "appShell.windowsMenu.proxy",
    items: [
      { id: "start_proxy", labelKey: "appShell.windowsMenu.startProxy" },
      { id: "stop_proxy", labelKey: "appShell.windowsMenu.stopProxy" },
      { kind: "divider" },
      { id: "toggle_system_proxy", labelKey: "appShell.windowsMenu.toggleSystemProxy" },
      { kind: "divider" },
      { id: "clear_sessions", labelKey: "appShell.windowsMenu.clearSessions" },
    ],
  },
  {
    id: "tools",
    labelKey: "appShell.windowsMenu.tools",
    items: [
      { id: "breakpoint_rules", labelKey: "appShell.windowsMenu.breakpointRules" },
      { id: "throttling_tool", labelKey: "appShell.windowsMenu.throttlingTool" },
      { kind: "divider" },
      { id: "install_cert", labelKey: "appShell.windowsMenu.installCert" },
      { id: "cert_status", labelKey: "appShell.windowsMenu.certStatus" },
      { kind: "divider" },
      { id: "ios_quick_actions", labelKey: "appShell.windowsMenu.iosQuickActions" },
      { id: "android_quick_actions", labelKey: "appShell.windowsMenu.androidQuickActions" },
      { id: "harmony_quick_actions", labelKey: "appShell.windowsMenu.harmonyQuickActions" },
      { kind: "divider" },
      { id: "adb_set_proxy", labelKey: "appShell.windowsMenu.adbSetProxy" },
      { id: "adb_clear_proxy", labelKey: "appShell.windowsMenu.adbClearProxy" },
    ],
  },
  {
    id: "window",
    labelKey: "appShell.windowsMenu.window",
    items: [
      { id: "window_minimize", labelKey: "appShell.windowsMenu.minimize" },
      { id: "window_toggle_maximize", labelKey: "appShell.windowsMenu.maximize" },
      { id: "window_toggle_fullscreen", labelKey: "appShell.windowsMenu.toggleFullScreen" },
      { kind: "divider" },
      { id: "window_close", labelKey: "appShell.windowsMenu.closeWindow" },
    ],
  },
  {
    id: "help",
    labelKey: "appShell.windowsMenu.help",
    items: [
      { id: "setup_wizard", labelKey: "appShell.windowsMenu.setupGuide" },
      { kind: "divider" },
      { id: "check_for_updates", labelKey: "appShell.windowsMenu.checkForUpdates" },
      { kind: "divider" },
      { id: "documentation", labelKey: "appShell.windowsMenu.documentation" },
      { id: "show_logs", labelKey: "appShell.windowsMenu.showLogs" },
      { id: "shortcuts", labelKey: "appShell.windowsMenu.shortcuts" },
    ],
  },
] as const;
