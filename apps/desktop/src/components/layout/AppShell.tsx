import { getCurrentWindow } from "@tauri-apps/api/window";
import { Box, Snackbar } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { AppShellActivityBar } from "@/components/layout/AppShellActivityBar";
import { AppShellDialogs } from "@/components/layout/AppShellDialogs";
import { AppShellStatusBar } from "@/components/layout/AppShellStatusBar";
import {
  AppShellTopControls,
  NON_MACOS_TOP_CONTROLS_HEIGHT,
} from "@/components/layout/AppShellTopControls";
import {
  useAdbActions,
  useMenuActions,
  useProxyLifecycle,
  useWindowControls,
  useZoomControl,
} from "@/components/layout/hooks";
import { isMacPlatform, isTauriRuntime } from "@/components/layout/hooks/helpers";
import { useBreakpointEvents } from "@/features/breakpoints/use-breakpoint-events";
import { useBreakpointStore } from "@/features/breakpoints/breakpoint.store";
import { BreakpointInterceptPanel } from "@/features/breakpoints/components/BreakpointInterceptPanel";
import { SetupWizard } from "@/features/setup-wizard/SetupWizard";
import { useI18n } from "@/i18n";
import { useSessionEvents } from "@/features/sessions/use-session-events";
import { useNotificationStore } from "@/services/notification.store";

const MACOS_TITLEBAR_HEIGHT = 38;

export function AppShell() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const isSessionsWorkspace = location.pathname === "/";
  const isCompactWorkspace =
    isSessionsWorkspace ||
    location.pathname === "/compose" ||
    location.pathname === "/collections" ||
    location.pathname === "/compare" ||
    location.pathname === "/rules" ||
    location.pathname === "/throttling" ||
    location.pathname === "/certificates";
  useBreakpointEvents();
  useSessionEvents();
  const pendingBreakpointCount = useBreakpointStore((s) => s.pendingHits.length);

  // --- Snackbar message shared across hooks ---
  const [menuSnackbarMessage, setMenuSnackbarMessage] = useState<string | null>(null);

  // --- Global notification queue (fed by reportCommandFailure etc.) ---
  const notificationQueue = useNotificationStore((s) => s.queue);
  const shiftNotification = useNotificationStore((s) => s.shift);
  const activeNotification = notificationQueue[0] ?? null;
  const snackbarMessage = menuSnackbarMessage ?? activeNotification?.message ?? null;

  // --- Proxy lifecycle ---
  const {
    proxyStatus,
    certificateStatus,
    port,
    isProxyBusy,
    isBusy,
    isWorkspacesError,
    systemProxyActionDisabled,
    portDialogOpen,
    portDraft,
    portDialogError,
    setPortDialogOpen,
    setPortDraft,
    setPortDialogError,
    openPortDialog,
    handleStartProxy,
    handleStopProxy,
    handlePortApply,
    handleSystemProxyToggle,
  } = useProxyLifecycle({ onSnackbarMessage: setMenuSnackbarMessage });

  // --- ADB actions ---
  const { handleAdbSetProxy, handleAdbClearProxy } = useAdbActions({
    port,
    proxyStatus,
    onSnackbarMessage: setMenuSnackbarMessage,
  });

  // --- Window controls ---
  const { runWindowCommand } = useWindowControls();

  // --- Menu actions ---
  const { handleMenuCommand } = useMenuActions({
    navigate,
    proxyStatus,
    handleStartProxy,
    handleStopProxy,
    handleSystemProxyToggle,
    handleAdbSetProxy,
    handleAdbClearProxy,
    runWindowCommand,
    onSnackbarMessage: setMenuSnackbarMessage,
  });

  // --- Zoom control ---
  useZoomControl();

  // --- Header actions (injected by child pages via Outlet context) ---
  const [headerActions, setHeaderActions] = useState<ReactNode | null>(null);

  // --- Platform layout ---
  const macosTitlebarEnabled = isTauriRuntime() && isMacPlatform();
  const topInset = macosTitlebarEnabled ? MACOS_TITLEBAR_HEIGHT : 0;
  const mainTopOffset = macosTitlebarEnabled ? topInset : NON_MACOS_TOP_CONTROLS_HEIGHT;
  const activityBarTopOffset = mainTopOffset;

  useEffect(() => {
    if (!macosTitlebarEnabled) {
      return;
    }

    void getCurrentWindow()
      .setTitleBarStyle("overlay")
      .catch(() => {
        // Keep the default title bar if the platform does not accept overlay mode.
      });
  }, [macosTitlebarEnabled]);

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
        workspaceConfigUnavailable={isWorkspacesError}
        macosTitlebarEnabled={macosTitlebarEnabled}
        onMenuAction={handleMenuCommand}
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
        startProxyLabel={
          certificateStatus?.trusted
            ? t("common.actions.startHttpsProxy")
            : t("common.actions.startProxy")
        }
        stopProxyLabel={t("common.actions.stopProxy")}
        systemProxyActionDisabled={systemProxyActionDisabled}
        systemProxyEnabled={proxyStatus?.systemProxyEnabled ?? false}
        systemProxyOffLabel={t("appShell.stopSystemProxyAction")}
        systemProxyOnLabel={t("appShell.startSystemProxyAction")}
      />

      <AppShellActivityBar
        locationPathname={location.pathname}
        pendingBreakpointCount={pendingBreakpointCount}
        topLayoutHeight={activityBarTopOffset}
      />

      <Box
        component="main"
        sx={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          mt: `${mainTopOffset}px`,
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
            p: isCompactWorkspace ? 1 : 2,
          }}
        >
          <Outlet context={{ setHeaderActions }} />
        </Box>

        <Box
          sx={{
            position: "absolute",
            right: 0,
            top: 0,
            height: "calc(100% - 40px)",
            width: "calc(100% - 420px)",
            minWidth: 640,
            zIndex: (theme) => theme.zIndex.drawer,
            transition: "transform 300ms ease",
            transform: pendingBreakpointCount > 0 ? "translateX(0)" : "translateX(100%)",
            pointerEvents: pendingBreakpointCount > 0 ? "auto" : "none",
          }}
        >
          {pendingBreakpointCount > 0 && <BreakpointInterceptPanel />}
        </Box>

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

      <SetupWizard />

      <Snackbar
        key={menuSnackbarMessage ?? activeNotification?.id ?? "snackbar"}
        autoHideDuration={4000}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        message={snackbarMessage}
        onClose={() => {
          if (menuSnackbarMessage !== null) {
            setMenuSnackbarMessage(null);
          } else if (activeNotification !== null) {
            shiftNotification();
          }
        }}
        open={snackbarMessage !== null}
        sx={{
          top: "50% !important",
          bottom: "auto !important",
          transform: "translateY(-50%)",
        }}
      />
    </Box>
  );
}
