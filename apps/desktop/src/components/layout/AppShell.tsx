import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  coerceAppError,
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
} from "@aiproxy/shared-types";
import { Box, Snackbar } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { AppShellActivityBar } from "@/components/layout/AppShellActivityBar";
import { AppShellDialogs } from "@/components/layout/AppShellDialogs";
import { AppShellStatusBar } from "@/components/layout/AppShellStatusBar";
import { AppShellTopControls } from "@/components/layout/AppShellTopControls";
import { useBreakpointEvents } from "@/features/breakpoints/use-breakpoint-events";
import { useBreakpointStore } from "@/features/breakpoints/breakpoint.store";
import { BreakpointInterceptPanel } from "@/features/breakpoints/components/BreakpointInterceptPanel";
import {
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import type { SessionsMenuAction } from "@/features/sessions/session-menu-actions";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";
import { onMenuEvent } from "@/services/events";
import {
  clearAndroidProxyViaAdb,
  clearSessions,
  getLocalIp,
  listAndroidAdbDevices,
  setAndroidProxyViaAdb,
} from "@/services/commands";

const MACOS_TITLEBAR_HEIGHT = 38;

function getErrorMessage(error: unknown, fallbackMessage: string) {
  const normalizedError = coerceAppError(error);

  if (normalizedError.message.trim().length > 0) {
    return normalizedError.message;
  }

  return fallbackMessage;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isMacPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";

  // Exclude Linux before checking for Mac — some Linux desktop themes may
  // appear in UA strings but should never get the macOS overlay titlebar.
  if (ua.includes("linux") || platform.includes("linux")) {
    return false;
  }

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}

export function AppShell() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const isSessionsWorkspace = location.pathname === "/";
  useBreakpointEvents();
  const pendingBreakpointCount = useBreakpointStore((s) => s.pendingHits.length);
  const { data: proxyStatus } = useProxyStatus();
  const { data: certificateStatus } = useCertificateStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const { data: workspaces = [] } = useWorkspaces();
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const currentWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null,
    [workspaceId, workspaces],
  );
  const configuredPort = currentWorkspace?.proxyPort ?? DEFAULT_PROXY_PORT;
  const configuredSslEnabled = currentWorkspace?.sslEnabled ?? false;
  const port = proxyStatus?.running ? proxyStatus.port : configuredPort;
  const [portDialogOpen, setPortDialogOpen] = useState(false);
  const [portDraft, setPortDraft] = useState(String(port));
  const [portDialogError, setPortDialogError] = useState<string | null>(null);
  const [menuSnackbarMessage, setMenuSnackbarMessage] = useState<string | null>(null);
  const [adbMenuActionPending, setAdbMenuActionPending] = useState(false);
  const [headerActions, setHeaderActions] = useState<ReactNode | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const macosTitlebarEnabled = isTauriRuntime() && isMacPlatform();
  const topInset = macosTitlebarEnabled ? MACOS_TITLEBAR_HEIGHT : 0;
  const topLayoutHeight = topInset;
  const isProxyBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending;
  const isSystemProxyBusy =
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending;
  const isBusy = isProxyBusy || isSystemProxyBusy || updateWorkspaceMutation.isPending;
  const systemProxyActionDisabled = isSystemProxyBusy || isProxyBusy || (!proxyStatus?.systemProxyEnabled && !(proxyStatus?.running ?? false));
  const initialStartProxyInput = useMemo(
    () => ({
      enableSsl: configuredSslEnabled,
      port: configuredPort,
      workspaceId,
    }),
    [configuredPort, configuredSslEnabled, workspaceId],
  );

  useEffect(() => {
    if (!macosTitlebarEnabled) {
      return;
    }

    void getCurrentWindow().setTitleBarStyle("overlay").catch(() => {
      // Keep the default title bar if the platform does not accept overlay mode.
    });
  }, [macosTitlebarEnabled]);

  useEffect(() => {
    if (!isTauriRuntime() || autoStartAttemptedRef.current) {
      return;
    }

    if (!proxyStatus || !certificateStatus || workspaces.length === 0) {
      return;
    }

    autoStartAttemptedRef.current = true;

    if (proxyStatus.running) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const startedStatus = await startProxyMutation.mutateAsync(initialStartProxyInput);

        if (cancelled || startedStatus.systemProxyEnabled) {
          return;
        }

        await enableSystemProxyMutation.mutateAsync(undefined);
      } catch {
        // Startup auto-boot is best-effort. Manual controls remain available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    certificateStatus,
    enableSystemProxyMutation,
    initialStartProxyInput,
    proxyStatus,
    startProxyMutation,
    workspaceId,
    workspaces.length,
  ]);

  function openPortDialog() {
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
  }

  function isPortInUseError(error: unknown) {
    const normalizedError = coerceAppError(error);
    const normalizedMessage = normalizedError.message.toLowerCase();

    return (
      normalizedError.code === "PORT_IN_USE" ||
      normalizedMessage.includes("already in use") ||
      normalizedMessage.includes("address already in use")
    );
  }

  function getProxyStartErrorMessage(error: unknown, requestedPort: number) {
    const normalizedError = coerceAppError(error);
    const errorPort =
      typeof normalizedError.details?.port === "number"
        ? normalizedError.details.port
        : requestedPort;

    if (isPortInUseError(normalizedError)) {
      return t("appShell.proxyPortInUse", {
        port: errorPort,
      });
    }

    return getErrorMessage(normalizedError, t("common.errors.generic"));
  }

  async function handleStartProxy(input = initialStartProxyInput) {
    try {
      await startProxyMutation.mutateAsync(input);
    } catch (error) {
      const requestedPort = input.port ?? port;
      const message = getProxyStartErrorMessage(error, requestedPort);

      if (isPortInUseError(error)) {
        setPortDraft(String(requestedPort));
        setPortDialogError(message);
        setPortDialogOpen(true);
        return;
      }

      setMenuSnackbarMessage(message);
    }
  }

  async function handleStopProxy() {
    try {
      await stopProxyMutation.mutateAsync(workspaceId);
    } catch (error) {
      setMenuSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  async function handlePortApply() {
    const nextPort = Number.parseInt(portDraft.trim(), 10);

    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setPortDialogError(t("appShell.proxyPortValidation"));
      return;
    }

    try {
      if (nextPort !== configuredPort) {
        await updateWorkspaceMutation.mutateAsync({
          proxyPort: nextPort,
          workspaceId,
        });
      }

      await startProxyMutation.mutateAsync({
        enableSsl: proxyStatus?.running ? proxyStatus.sslEnabled : configuredSslEnabled,
        port: nextPort,
        workspaceId,
      });

      setPortDialogOpen(false);
    } catch (error) {
      setPortDialogError(getProxyStartErrorMessage(error, nextPort));
    }
  }

  async function handleSystemProxyToggle() {
    if (systemProxyActionDisabled) {
      return;
    }

    try {
      if (proxyStatus?.systemProxyEnabled) {
        await disableSystemProxyMutation.mutateAsync(undefined);
        return;
      }

      await enableSystemProxyMutation.mutateAsync(undefined);
    } catch (error) {
      setMenuSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  async function handleAdbSetProxy() {
    if (adbMenuActionPending) {
      return;
    }

    setAdbMenuActionPending(true);

    try {
      if (!proxyStatus?.running) {
        throw new Error(t("certificatesPage.mobile.adbProxyRequiresRunningProxy"));
      }

      const adbDevices = await listAndroidAdbDevices();
      const targetDevice = adbDevices[0];

      if (!targetDevice) {
        throw new Error(t("certificatesPage.mobile.adbNoDevices"));
      }

      if (targetDevice.state !== "device") {
        throw new Error(t("certificatesPage.mobile.adbDeviceStateHint", {
          state: targetDevice.state,
        }));
      }

      const localIps = await getLocalIp();
      const localIp = localIps[0];

      if (!localIp) {
        throw new Error(t("certificatesPage.mobile.adbProxyRequiresLocalIp"));
      }

      const result = await setAndroidProxyViaAdb({
        deviceSerial: targetDevice.serial,
        host: localIp,
        port,
      });

      setMenuSnackbarMessage(t("certificatesPage.mobile.adbSetProxySuccessBody", {
        deviceSerial: result.deviceSerial,
        proxyAddress: result.proxyAddress ?? `${localIp}:${port}`,
      }));
    } catch (error) {
      setMenuSnackbarMessage(getErrorMessage(error, t("certificatesPage.mobile.adbSetProxyErrorTitle")));
    } finally {
      setAdbMenuActionPending(false);
    }
  }

  async function handleAdbClearProxy() {
    if (adbMenuActionPending) {
      return;
    }

    setAdbMenuActionPending(true);

    try {
      const adbDevices = await listAndroidAdbDevices();
      const targetDevice = adbDevices[0];

      if (!targetDevice) {
        throw new Error(t("certificatesPage.mobile.adbNoDevices"));
      }

      if (targetDevice.state !== "device") {
        throw new Error(t("certificatesPage.mobile.adbDeviceStateHint", {
          state: targetDevice.state,
        }));
      }

      const result = await clearAndroidProxyViaAdb({
        deviceSerial: targetDevice.serial,
      });
      setMenuSnackbarMessage(t("certificatesPage.mobile.adbClearProxySuccessBody", {
        deviceSerial: result.deviceSerial,
      }));
    } catch (error) {
      setMenuSnackbarMessage(getErrorMessage(error, t("certificatesPage.mobile.adbClearProxyErrorTitle")));
    } finally {
      setAdbMenuActionPending(false);
    }
  }

  // --- Menu bar event handling ---
  const setThemePreference = useAppPreferencesStore((s) => s.setThemePreference);
  const menuHandlerRef = useRef({
    handleAdbClearProxy,
    handleAdbSetProxy,
    handleStartProxy,
    handleStopProxy,
    navigate,
    proxyStatus,
    handleSystemProxyToggle,
    setThemePreference,
  });

  useEffect(() => {
    menuHandlerRef.current = {
      handleAdbClearProxy,
      handleAdbSetProxy,
      handleStartProxy,
      handleStopProxy,
      navigate,
      proxyStatus,
      handleSystemProxyToggle,
      setThemePreference,
    };
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onMenuEvent((payload) => {
      const h = menuHandlerRef.current;
      const navigateToSessionsMenuAction = (menuAction: SessionsMenuAction) => {
        h.navigate("/", {
          state: {
            sessionsMenuAction: menuAction,
          },
        });
      };

      switch (payload.menuId) {
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
        case "documentation": {
          const docsUrl = "https://github.com/jakejiang/aiproxy";
          window.open(docsUrl, "_blank");
          break;
        }
        case "shortcuts":
          window.dispatchEvent(new CustomEvent("aiproxy-menu-shortcuts"));
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // --- Zoom state ---
  const [zoomLevel, setZoomLevel] = useState(1);
  useEffect(() => {
    const root = document.documentElement;
    root.style.zoom = String(zoomLevel);
  }, [zoomLevel]);

  useEffect(() => {
    function handleZoomIn() {
      setZoomLevel((prev) => Math.min(prev + 0.1, 2));
    }
    function handleZoomOut() {
      setZoomLevel((prev) => Math.max(prev - 0.1, 0.5));
    }
    function handleZoomReset() {
      setZoomLevel(1);
    }

    window.addEventListener("aiproxy-menu-zoom-in", handleZoomIn);
    window.addEventListener("aiproxy-menu-zoom-out", handleZoomOut);
    window.addEventListener("aiproxy-menu-zoom-reset", handleZoomReset);

    return () => {
      window.removeEventListener("aiproxy-menu-zoom-in", handleZoomIn);
      window.removeEventListener("aiproxy-menu-zoom-out", handleZoomOut);
      window.removeEventListener("aiproxy-menu-zoom-reset", handleZoomReset);
    };
  }, []);

  return (
    <Box
      sx={(theme) => ({
        bgcolor: "background.default",
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        backgroundImage:
          theme.palette.mode === "dark"
            ? "linear-gradient(180deg, rgba(96, 165, 250, 0.06), rgba(13, 17, 23, 0) 220px)"
            : "linear-gradient(180deg, rgba(37, 99, 235, 0.045), rgba(244, 247, 251, 0) 220px)",
      })}
    >
      <AppShellTopControls
        headerActions={headerActions}
        isProxyBusy={isProxyBusy}
        macosTitlebarEnabled={macosTitlebarEnabled}
        onStartProxy={() => {
          void handleStartProxy();
        }}
        onStopProxy={() => {
          void handleStopProxy();
        }}
        onSystemProxyToggle={() => {
          void handleSystemProxyToggle();
        }}
        proxyRunning={proxyStatus?.running ?? false}
        startProxyLabel={certificateStatus?.trusted ? t("common.actions.startHttpsProxy") : t("common.actions.startProxy")}
        stopProxyLabel={t("common.actions.stopProxy")}
        systemProxyActionDisabled={systemProxyActionDisabled}
        systemProxyEnabled={proxyStatus?.systemProxyEnabled ?? false}
        systemProxyOffLabel={t("appShell.stopSystemProxyAction")}
        systemProxyOnLabel={t("appShell.startSystemProxyAction")}
      />

      <AppShellActivityBar
        locationPathname={location.pathname}
        pendingBreakpointCount={pendingBreakpointCount}
        topLayoutHeight={topLayoutHeight}
      />

      <Box
        component="main"
        sx={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          mt: `${topLayoutHeight}px`,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            p: isSessionsWorkspace || location.pathname === "/compose" ? 1 : 2,
          }}
        >
          <Outlet context={{ setHeaderActions }} />
        </Box>

        {pendingBreakpointCount > 0 && <BreakpointInterceptPanel />}

        <AppShellStatusBar
          certificateStatus={certificateStatus}
          locale={locale}
          onCertificatesClick={() => navigate("/certificates")}
          onPortClick={openPortDialog}
          onRulesClick={() => navigate("/rules")}
          onSystemProxyToggle={() => {
            void handleSystemProxyToggle();
          }}
          pendingBreakpointCount={pendingBreakpointCount}
          port={port}
          proxyStatus={proxyStatus}
        />
      </Box>

      <AppShellDialogs
        isBusy={isBusy}
        isRunning={proxyStatus?.running ?? false}
        onClosePortDialog={() => setPortDialogOpen(false)}
        onPortApply={handlePortApply}
        onPortDraftChange={(value) => {
          setPortDraft(value);
          if (portDialogError) {
            setPortDialogError(null);
          }
        }}
        portDialogError={portDialogError}
        portDialogOpen={portDialogOpen}
        portDraft={portDraft}
      />

      <Snackbar
        autoHideDuration={4000}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        message={menuSnackbarMessage}
        onClose={() => setMenuSnackbarMessage(null)}
        open={menuSnackbarMessage !== null}
        sx={{
          top: "50% !important",
          bottom: "auto !important",
          transform: "translateY(-50%)",
        }}
      />
    </Box>
  );
}
