import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
import { Box } from "@mui/material";
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
import { useLoadWorkspace } from "@/features/workspace-manager/use-workspaces";
import { useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";
import { onMenuEvent } from "@/services/events";
import { clearSessions } from "@/services/commands";

const MACOS_TITLEBAR_HEIGHT = 38;

export type AppShellOutletContext = {
  setHeaderActions: (actions: ReactNode | null) => void;
};

function getErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
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
  const { data: workspaces = [] } = useWorkspaces();
  const loadWorkspaceMutation = useLoadWorkspace();
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const activeWorkspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceDialogError, setWorkspaceDialogError] = useState<string | null>(null);
  const [portDialogOpen, setPortDialogOpen] = useState(false);
  const [portDraft, setPortDraft] = useState(String(port));
  const [portDialogError, setPortDialogError] = useState<string | null>(null);
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
  const isBusy = isProxyBusy || isSystemProxyBusy;
  const systemProxyActionDisabled = isSystemProxyBusy || isProxyBusy || (!proxyStatus?.systemProxyEnabled && !(proxyStatus?.running ?? false));
  const initialStartProxyInput = useMemo(
    () => ({
      enableSsl: certificateStatus?.trusted ?? false,
      port,
      workspaceId,
    }),
    [certificateStatus?.trusted, port, workspaceId],
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
    port,
    proxyStatus,
    startProxyMutation,
    workspaceId,
    workspaces.length,
  ]);

  function openWorkspaceDialog() {
    setWorkspaceDialogError(null);
    setWorkspaceDialogOpen(true);
  }

  function openPortDialog() {
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
  }

  async function handleWorkspaceSwitch(nextWorkspaceId: string) {
    if (nextWorkspaceId === workspaceId) {
      setWorkspaceDialogOpen(false);
      return;
    }

    try {
      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: proxyStatus.sslEnabled,
          port,
          workspaceId: nextWorkspaceId,
        });
      }

      await loadWorkspaceMutation.mutateAsync(nextWorkspaceId);
      setWorkspaceDialogOpen(false);
    } catch (error) {
      setWorkspaceDialogError(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  async function handlePortApply() {
    const nextPort = Number.parseInt(portDraft.trim(), 10);

    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setPortDialogError(t("appShell.proxyPortValidation"));
      return;
    }

    if (nextPort === port) {
      setPortDialogOpen(false);
      return;
    }

    try {
      await startProxyMutation.mutateAsync({
        enableSsl: proxyStatus?.running ? proxyStatus.sslEnabled : (certificateStatus?.trusted ?? false),
        port: nextPort,
        workspaceId,
      });

      setPortDialogOpen(false);
    } catch (error) {
      setPortDialogError(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  async function handleSystemProxyToggle() {
    if (systemProxyActionDisabled) {
      return;
    }

    if (proxyStatus?.systemProxyEnabled) {
      await disableSystemProxyMutation.mutateAsync(undefined);
      return;
    }

    await enableSystemProxyMutation.mutateAsync(undefined);
  }

  // --- Menu bar event handling ---
  const setThemePreference = useAppPreferencesStore((s) => s.setThemePreference);
  const menuHandlerRef = useRef({
    navigate,
    proxyStatus,
    initialStartProxyInput,
    workspaceId,
    startProxyMutation,
    stopProxyMutation,
    handleSystemProxyToggle,
    setThemePreference,
  });

  useEffect(() => {
    menuHandlerRef.current = {
      navigate,
      proxyStatus,
      initialStartProxyInput,
      workspaceId,
      startProxyMutation,
      stopProxyMutation,
      handleSystemProxyToggle,
      setThemePreference,
    };
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onMenuEvent((payload) => {
      const h = menuHandlerRef.current;
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
            h.startProxyMutation.mutate(h.initialStartProxyInput);
          }
          break;
        case "stop_proxy":
          if (h.proxyStatus?.running) {
            h.stopProxyMutation.mutate(h.workspaceId);
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
        case "import_har":
          window.dispatchEvent(new CustomEvent("aiproxy-menu-import-har"));
          break;
        case "export_har":
          window.dispatchEvent(new CustomEvent("aiproxy-menu-export-har"));
          break;
        case "export_curl":
          window.dispatchEvent(new CustomEvent("aiproxy-menu-export-curl"));
          break;
        case "export_snapshot":
          window.dispatchEvent(new CustomEvent("aiproxy-menu-export-snapshot"));
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
    <Box sx={{ display: "flex", height: "100vh", overflow: "hidden", bgcolor: "background.default" }}>
      <AppShellTopControls
        headerActions={headerActions}
        isProxyBusy={isProxyBusy}
        macosTitlebarEnabled={macosTitlebarEnabled}
        onStartProxy={() => startProxyMutation.mutate(initialStartProxyInput)}
        onStopProxy={() => stopProxyMutation.mutate(workspaceId)}
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
        }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            p: isSessionsWorkspace ? 0.5 : 2,
          }}
        >
          <Outlet context={{ setHeaderActions }} />
        </Box>

        {pendingBreakpointCount > 0 && <BreakpointInterceptPanel />}

        <AppShellStatusBar
          activeWorkspaceName={activeWorkspaceName}
          certificateStatus={certificateStatus}
          locale={locale}
          onCertificatesClick={() => navigate("/certificates")}
          onPortClick={openPortDialog}
          onRulesClick={() => navigate("/rules")}
          onSystemProxyToggle={() => {
            void handleSystemProxyToggle();
          }}
          onWorkspaceClick={openWorkspaceDialog}
          pendingBreakpointCount={pendingBreakpointCount}
          port={port}
          proxyStatus={proxyStatus}
        />
      </Box>

      <AppShellDialogs
        isBusy={isBusy}
        isRunning={proxyStatus?.running ?? false}
        loadWorkspacePending={loadWorkspaceMutation.isPending}
        onClosePortDialog={() => setPortDialogOpen(false)}
        onCloseWorkspaceDialog={() => setWorkspaceDialogOpen(false)}
        onPortApply={handlePortApply}
        onPortDraftChange={(value) => {
          setPortDraft(value);
          if (portDialogError) {
            setPortDialogError(null);
          }
        }}
        onWorkspaceSwitch={handleWorkspaceSwitch}
        portDialogError={portDialogError}
        portDialogOpen={portDialogOpen}
        portDraft={portDraft}
        workspaceDialogError={workspaceDialogError}
        workspaceDialogOpen={workspaceDialogOpen}
        workspaceId={workspaceId}
        workspaces={workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          proxyPort: workspace.proxyPort,
        }))}
      />
    </Box>
  );
}
