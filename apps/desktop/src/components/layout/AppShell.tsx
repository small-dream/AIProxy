import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import SettingsEthernetRoundedIcon from "@mui/icons-material/SettingsEthernetRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@pharles/shared-types";
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  OutlinedInput,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { useBreakpointEvents } from "@/features/breakpoints/use-breakpoint-events";
import { useBreakpointStore } from "@/features/breakpoints/breakpoint.store";
import { BreakpointInterceptPanel } from "@/features/breakpoints/components/BreakpointInterceptPanel";
import { navigationItems } from "@/features/navigation/navigation-items";
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

const ACTIVITY_BAR_WIDTH = 48;
const MACOS_TITLEBAR_HEIGHT = 38;
const TOP_CONTROLS_VERTICAL_OFFSET = 10;
const TOP_CONTROLS_HORIZONTAL_GUTTER = 24;
const MACOS_WINDOW_CONTROLS_SAFE_WIDTH = 112;
const ACTIVITY_BAR_BG = "#2c2c2c";
const ACTIVITY_BAR_ICON = "rgba(255, 255, 255, 0.42)";
const ACTIVITY_BAR_ICON_ACTIVE = "#f5f5f5";
const ACTIVITY_BAR_DIVIDER = "rgba(255, 255, 255, 0.1)";

type StatusItemProps = {
  active?: boolean;
  icon?: ReactNode;
  label: string;
  monospaced?: boolean;
  onClick?: () => void;
  title?: string;
};

export type AppShellOutletContext = {
  setHeaderActions: (actions: ReactNode | null) => void;
};

function StatusSeparator() {
  return (
    <Typography
      color="text.disabled"
      sx={{ flexShrink: 0, fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 12, px: 0.25, userSelect: "none" }}
    >
      |
    </Typography>
  );
}

function StatusItem({ active = true, icon, label, monospaced = false, onClick, title }: StatusItemProps) {
  const content = (
    <Stack
      alignItems="center"
      direction="row"
      spacing={0.625}
      sx={{
        color: active ? "text.primary" : "text.secondary",
        minHeight: 24,
        minWidth: 0,
        px: 0.875,
        py: 0.25,
        whiteSpace: "nowrap",
      }}
    >
      {icon ? (
        <Box
          sx={{
            alignItems: "center",
            color: active ? "inherit" : "text.disabled",
            display: "flex",
            flexShrink: 0,
            "& > svg": {
              fontSize: 14,
            },
          }}
        >
          {icon}
        </Box>
      ) : null}
      <Typography
        sx={{
          fontFamily: monospaced ? "JetBrains Mono, Consolas, monospace" : "inherit",
          fontSize: 12.5,
          fontWeight: onClick ? 600 : 500,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </Typography>
    </Stack>
  );

  if (!onClick) {
    return content;
  }

  const interactiveNode = (
    <ButtonBase
      onClick={onClick}
      sx={{
        borderRadius: 1,
        display: "block",
        flexShrink: 0,
        textAlign: "left",
        transition: "background-color 140ms ease, color 140ms ease",
        "&:hover": {
          bgcolor: "action.selected",
        },
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 1,
        },
      }}
    >
      {content}
    </ButtonBase>
  );

  return title ? (
    <Tooltip arrow title={title}>
      {interactiveNode}
    </Tooltip>
  ) : (
    interactiveNode
  );
}

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

  return /mac/i.test(navigator.userAgent) || /mac/i.test(navigator.platform);
}

export function AppShell() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
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
  const workspaceNavigationItems = navigationItems.filter((item) => item.group === "workspace");
  const manageNavigationItems = navigationItems.filter((item) => item.group === "manage");
  const settingsItem = manageNavigationItems.find((item) => item.to === "/settings");
  const topManageItems = manageNavigationItems.filter((item) => item.to !== "/settings");
  const macosTitlebarEnabled = isTauriRuntime() && isMacPlatform();
  const topInset = macosTitlebarEnabled ? MACOS_TITLEBAR_HEIGHT : 0;
  const topLayoutHeight = topInset;
  const sslLabel = proxyStatus?.sslEnabled
    ? t("appShell.sslOn")
    : certificateStatus?.trusted
      ? t("appShell.sslReady")
      : t("appShell.sslSetup");
  const isBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending ||
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending;
  const systemProxyActionDisabled = isBusy || (!proxyStatus?.systemProxyEnabled && !(proxyStatus?.running ?? false));
  const initialStartProxyInput = {
    enableSsl: certificateStatus?.trusted ?? false,
    port,
    workspaceId,
  };

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

  const proxyControls = (
    <Stack direction="row" spacing={1.25}>
      {proxyStatus?.running ? (
        <TopBarActionButton
          disabled={isBusy}
          icon={<StopRoundedIcon />}
          label={t("common.actions.stopProxy")}
          onClick={() => stopProxyMutation.mutate(workspaceId)}
          tone="error"
          variant="filled"
        />
      ) : (
        <TopBarActionButton
          disabled={isBusy}
          icon={<PlayArrowRoundedIcon />}
          label={certificateStatus?.trusted ? t("common.actions.startHttpsProxy") : t("common.actions.startProxy")}
          onClick={() => startProxyMutation.mutate(initialStartProxyInput)}
          tone="primary"
          variant="filled"
        />
      )}

      <TopBarActionButton
        ariaPressed={proxyStatus?.systemProxyEnabled ?? false}
        disabled={systemProxyActionDisabled}
        icon={<LanguageRoundedIcon />}
        label={
          proxyStatus?.systemProxyEnabled
            ? t("appShell.stopSystemProxyAction")
            : t("appShell.startSystemProxyAction")
        }
        onClick={() => {
          void handleSystemProxyToggle();
        }}
        tone={proxyStatus?.systemProxyEnabled ? "success" : "default"}
        variant={proxyStatus?.systemProxyEnabled ? "filled" : "outlined"}
      />
    </Stack>
  );

  const topControls = (
    <Stack
      alignItems="center"
      direction="row"
      spacing={1.25}
      sx={{
        flexWrap: "wrap",
        justifyContent: "center",
        rowGap: 1,
      }}
    >
      {proxyControls}
      {headerActions}
    </Stack>
  );

  function renderNavigationIcon(item: typeof navigationItems[number], options?: { badgeContent?: number }) {
    const selected = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);

    return (
      <Tooltip arrow key={item.to} placement="right" title={t(item.labelKey)}>
        <ListItemButton
          component={NavLink}
          selected={selected}
          to={item.to}
          sx={{
            alignItems: "center",
            borderRadius: 0,
            color: selected ? ACTIVITY_BAR_ICON_ACTIVE : ACTIVITY_BAR_ICON,
            justifyContent: "center",
            minHeight: 60,
            px: 0,
            position: "relative",
            transition: "background-color 140ms ease, color 140ms ease",
            "&::before": {
              bgcolor: ACTIVITY_BAR_ICON_ACTIVE,
              borderRadius: 999,
              content: '""',
              height: 30,
              left: 0,
              opacity: selected ? 1 : 0,
              position: "absolute",
              top: "50%",
              transform: "translateY(-50%)",
              transition: "opacity 140ms ease",
              width: 3,
            },
            "& .MuiListItemIcon-root": {
              alignItems: "center",
              color: "inherit",
              justifyContent: "center",
              minWidth: 0,
            },
            "& .MuiSvgIcon-root": {
              fontSize: 32,
            },
            "&.Mui-selected": {
              backgroundColor: "transparent",
            },
            "&.Mui-selected:hover": {
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            },
            "&:hover": {
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            },
          }}
        >
          <ListItemIcon sx={{ position: "relative" }}>
            {item.icon}
            {options?.badgeContent ? (
              <Box
                sx={{
                  alignItems: "center",
                  bgcolor: "primary.main",
                  borderRadius: 999,
                  border: "2px solid #2c2c2c",
                  bottom: -3,
                  color: "primary.contrastText",
                  display: "flex",
                  fontSize: 11,
                  fontWeight: 700,
                  height: 22,
                  justifyContent: "center",
                  minWidth: 22,
                  position: "absolute",
                  right: -16,
                  px: 0.5,
                }}
              >
                {options.badgeContent > 9 ? "9+" : options.badgeContent}
              </Box>
            ) : null}
          </ListItemIcon>
        </ListItemButton>
      </Tooltip>
    );
  }

  return (
    <Box sx={{ display: "flex", height: "100vh", overflow: "hidden", bgcolor: "background.default" }}>
      {macosTitlebarEnabled ? (
        <Box
          sx={{
            backdropFilter: "blur(14px)",
            bgcolor: "transparent",
            height: MACOS_TITLEBAR_HEIGHT,
            left: 0,
            position: "fixed",
            right: 0,
            top: 0,
            zIndex: (theme) => theme.zIndex.appBar + 1,
          }}
        >
          <Box
            data-tauri-drag-region
            sx={{
              height: "100%",
              inset: 0,
              position: "absolute",
            }}
          />
          <Box
            sx={{
              alignItems: "center",
              display: "flex",
              height: "100%",
              inset: 0,
              justifyContent: "center",
              pointerEvents: "none",
              position: "absolute",
              transform: `translateY(${TOP_CONTROLS_VERTICAL_OFFSET}px)`,
            }}
          >
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                maxWidth: `calc(100vw - ${MACOS_WINDOW_CONTROLS_SAFE_WIDTH * 2}px)`,
                pointerEvents: "auto",
                width: `calc(100vw - ${MACOS_WINDOW_CONTROLS_SAFE_WIDTH * 2}px)`,
              }}
            >
              {topControls}
            </Box>
          </Box>
        </Box>
      ) : null}

      {!macosTitlebarEnabled ? (
        <Box
          sx={{
            alignItems: "center",
            display: "flex",
            justifyContent: "center",
            left: 0,
            position: "fixed",
            right: 0,
            top: 12 + TOP_CONTROLS_VERTICAL_OFFSET,
            zIndex: (theme) => theme.zIndex.appBar + 1,
          }}
        >
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              maxWidth: `calc(100vw - ${TOP_CONTROLS_HORIZONTAL_GUTTER * 2}px)`,
              width: `calc(100vw - ${TOP_CONTROLS_HORIZONTAL_GUTTER * 2}px)`,
            }}
          >
            {topControls}
          </Box>
        </Box>
      ) : null}

      <Drawer
        sx={{
          "& .MuiDrawer-paper": {
            alignItems: "center",
            backgroundColor: ACTIVITY_BAR_BG,
            borderRight: `1px solid ${ACTIVITY_BAR_DIVIDER}`,
            borderRadius: 0,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            height: `calc(100vh - ${topLayoutHeight}px)`,
            mt: `${topLayoutHeight}px`,
            overflow: "hidden",
            px: 0,
            py: 0,
            width: ACTIVITY_BAR_WIDTH,
          },
          flexShrink: 0,
          width: ACTIVITY_BAR_WIDTH,
        }}
        variant="permanent"
      >
        <Stack sx={{ flex: 1, minHeight: 0, width: "100%" }}>
          <List disablePadding sx={{ width: "100%" }}>
            {workspaceNavigationItems.map((item) =>
              renderNavigationIcon(
                item,
                item.to === "/rules" && pendingBreakpointCount > 0
                  ? { badgeContent: pendingBreakpointCount }
                  : undefined,
              ),
            )}
          </List>

          <List disablePadding sx={{ width: "100%" }}>
            {topManageItems.map((item) => renderNavigationIcon(item))}
          </List>

          <Box sx={{ flex: 1 }} />

          {settingsItem ? (
            <>
              <Divider sx={{ borderColor: ACTIVITY_BAR_DIVIDER, mx: 1.5, my: 0.75 }} />
              <List disablePadding sx={{ pb: 0.75, width: "100%" }}>
                {renderNavigationIcon(settingsItem)}
              </List>
            </>
          ) : null}
        </Stack>
      </Drawer>

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
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>
          <Outlet context={{ setHeaderActions }} />
        </Box>

        {pendingBreakpointCount > 0 && <BreakpointInterceptPanel />}

        <Divider />

        <Stack
          alignItems="center"
          direction="row"
          spacing={0.25}
          sx={{
            bgcolor: "background.paper",
            minHeight: 32,
            overflowX: "auto",
            px: 1,
            py: 0.375,
            scrollbarWidth: "thin",
            whiteSpace: "nowrap",
          }}
        >
          <StatusItem
            active={proxyStatus?.running ?? false}
            icon={<FiberManualRecordRoundedIcon />}
            label={proxyStatus?.running ? t("common.states.recording") : t("common.states.idle")}
          />

          <StatusSeparator />

          <StatusItem
            icon={<BoltRoundedIcon />}
            label={activeWorkspaceName}
            onClick={openWorkspaceDialog}
            title={t("appShell.switchProxyPreset")}
          />

          <StatusSeparator />

          <StatusItem
            icon={<SettingsEthernetRoundedIcon />}
            label={t("appShell.portStatus", { port })}
            monospaced
            onClick={openPortDialog}
            title={t("appShell.changePortTitle")}
          />

          <StatusSeparator />

          <StatusItem
            active={proxyStatus?.systemProxyEnabled ?? false}
            icon={<LanguageRoundedIcon />}
            label={proxyStatus?.systemProxyEnabled ? t("appShell.systemProxyOn") : t("appShell.systemProxyOff")}
            onClick={() => {
              void handleSystemProxyToggle();
            }}
            title={
              proxyStatus?.systemProxyEnabled
                ? t("appShell.statusDisableSystemProxy")
                : proxyStatus?.running
                  ? t("appShell.statusEnableSystemProxy")
                  : t("appShell.startProxyBeforeSystemProxy")
            }
          />

          <StatusSeparator />

          <StatusItem
            active={Boolean(proxyStatus?.sslEnabled || certificateStatus?.trusted)}
            icon={<LockRoundedIcon />}
            label={sslLabel}
            onClick={() => navigate("/certificates")}
            title={t("appShell.openCertificatesPage")}
          />

          {pendingBreakpointCount > 0 && (
            <>
              <StatusSeparator />
              <StatusItem
                active
                icon={<PauseCircleRoundedIcon />}
                label={t("appShell.breakpointsPending", {
                  count: pendingBreakpointCount,
                  suffix: locale === "en" && pendingBreakpointCount > 1 ? "s" : "",
                })}
                onClick={() => navigate("/rules")}
                title={t("appShell.breakpointsPendingTitle")}
              />
            </>
          )}
        </Stack>
      </Box>

      <Dialog fullWidth maxWidth="xs" onClose={() => setWorkspaceDialogOpen(false)} open={workspaceDialogOpen}>
        <DialogTitle>{t("appShell.switchPresetTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Typography color="text.secondary" variant="body2">
              {proxyStatus?.running
                ? t("appShell.switchPresetRestartHint")
                : t("appShell.switchPresetRestartHint")}
            </Typography>
            {workspaceDialogError ? (
              <Typography color="error" variant="caption">
                {workspaceDialogError}
              </Typography>
            ) : null}
            <List disablePadding>
              {workspaces.map((workspace) => {
                const isActive = workspace.id === workspaceId;
                return (
                  <ListItemButton
                    key={workspace.id}
                    selected={isActive}
                    disabled={isActive || loadWorkspaceMutation.isPending}
                    onClick={() => void handleWorkspaceSwitch(workspace.id)}
                    sx={{ borderRadius: 2, mb: 0.5 }}
                  >
                    <ListItemText
                      primary={workspace.name}
                      secondary={`:${workspace.proxyPort}`}
                      primaryTypographyProps={{ fontWeight: isActive ? 600 : 400 }}
                    />
                    {isActive && (
                      <Chip size="small" label={t("proxyPresets.active")} color="success" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setWorkspaceDialogOpen(false)}>{t("common.actions.cancel")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog fullWidth maxWidth="xs" onClose={() => setPortDialogOpen(false)} open={portDialogOpen}>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void handlePortApply();
          }}
        >
          <DialogTitle>{t("appShell.changePortTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography color="text.secondary" variant="body2">
                {proxyStatus?.running
                  ? t("appShell.portChangesRestartImmediately")
                  : t("appShell.portChangesStartOnNewPort")}
              </Typography>
              <OutlinedInput
                autoFocus
                error={Boolean(portDialogError)}
                inputProps={{ inputMode: "numeric", max: 65535, min: 1, pattern: "[0-9]*" }}
                onChange={(event) => {
                  setPortDraft(event.target.value);
                  if (portDialogError) {
                    setPortDialogError(null);
                  }
                }}
                placeholder={String(DEFAULT_PROXY_PORT)}
                value={portDraft}
              />
              {portDialogError ? (
                <Typography color="error" variant="caption">
                  {portDialogError}
                </Typography>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setPortDialogOpen(false)}>{t("common.actions.cancel")}</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {proxyStatus?.running ? t("common.actions.applyAndRestart") : t("common.actions.startOnNewPort")}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}
