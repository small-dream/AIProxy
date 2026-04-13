import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
import MenuIcon from "@mui/icons-material/Menu";
import MoreVertRoundedIcon from "@mui/icons-material/MoreVertRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import SettingsEthernetRoundedIcon from "@mui/icons-material/SettingsEthernetRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@pharles/shared-types";
import {
  AppBar,
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  OutlinedInput,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useBreakpointEvents } from "@/features/breakpoints/use-breakpoint-events";
import { useBreakpointStore } from "@/features/breakpoints/breakpoint.store";
import { BreakpointInterceptPanel } from "@/features/breakpoints/components/BreakpointInterceptPanel";
import { navigationItems } from "@/features/navigation/navigation-items";
import {
  useClearSessions,
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import { useI18n } from "@/i18n";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";
import { getSurfaceShadow } from "@/themes/app-theme";

const NAVIGATION_WIDTH = 228;

type StatusItemProps = {
  active?: boolean;
  icon?: ReactNode;
  label: string;
  monospaced?: boolean;
  onClick?: () => void;
  title?: string;
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

export function AppShell() {
  const { locale, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationExpanded = useAppShellStore((state) => state.navigationExpanded);
  const toggleNavigation = useAppShellStore((state) => state.toggleNavigation);
  useBreakpointEvents();
  const pendingBreakpointCount = useBreakpointStore((s) => s.pendingHits.length);
  const { data: proxyStatus } = useProxyStatus();
  const { data: certificateStatus } = useCertificateStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const clearSessionsMutation = useClearSessions();
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const [moreAnchorEl, setMoreAnchorEl] = useState<null | HTMLElement>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState(workspaceId);
  const [workspaceDialogError, setWorkspaceDialogError] = useState<string | null>(null);
  const [portDialogOpen, setPortDialogOpen] = useState(false);
  const [portDraft, setPortDraft] = useState(String(port));
  const [portDialogError, setPortDialogError] = useState<string | null>(null);
  const isMoreMenuOpen = Boolean(moreAnchorEl);
  const workspaceNavigationItems = navigationItems.filter((item) => item.group === "workspace");
  const manageNavigationItems = navigationItems.filter((item) => item.group === "manage");
  const settingsItem = manageNavigationItems.find((item) => item.to === "/settings");
  const topManageItems = manageNavigationItems.filter((item) => item.to !== "/settings");
  const sslLabel = proxyStatus?.sslEnabled
    ? t("appShell.sslOn")
    : certificateStatus?.trusted
      ? t("appShell.sslReady")
      : t("appShell.sslSetup");
  const isBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending ||
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending ||
    clearSessionsMutation.isPending;
  const systemProxyActionDisabled = isBusy || (!proxyStatus?.systemProxyEnabled && !(proxyStatus?.running ?? false));

  function openWorkspaceDialog() {
    setWorkspaceDraft(workspaceId);
    setWorkspaceDialogError(null);
    setWorkspaceDialogOpen(true);
  }

  function openPortDialog() {
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
  }

  async function handleWorkspaceSwitch() {
    const nextWorkspaceId = workspaceDraft.trim();

    if (!nextWorkspaceId) {
      setWorkspaceDialogError(t("appShell.workspaceRequired"));
      return;
    }

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
      } else {
        await stopProxyMutation.mutateAsync(nextWorkspaceId);
      }

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

  return (
    <Box sx={{ display: "flex", height: "100vh", overflow: "hidden", bgcolor: "background.default" }}>
      <AppBar
        color="transparent"
        elevation={0}
        position="fixed"
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          backdropFilter: "blur(12px)",
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: 64 }}>
          <IconButton color="inherit" onClick={toggleNavigation}>
            <MenuIcon />
          </IconButton>

          <Stack spacing={0.125} sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700, letterSpacing: 0.2 }} variant="h6">
              Pharles
            </Typography>
            <Typography color="text.secondary" noWrap variant="caption">
              {t("appShell.appSubtitle")}
            </Typography>
          </Stack>

          <Box sx={{ flex: 1 }} />

          {proxyStatus?.running ? (
            <Button
              color="error"
              disabled={isBusy}
              onClick={() => stopProxyMutation.mutate(workspaceId)}
              size="small"
              startIcon={<StopRoundedIcon />}
              sx={{ borderRadius: 999, px: 1.75 }}
              variant="contained"
            >
              {t("common.actions.stopProxy")}
            </Button>
          ) : (
            <Button
              disabled={isBusy}
              onClick={() =>
                startProxyMutation.mutate({
                  enableSsl: certificateStatus?.trusted ?? false,
                  port,
                  workspaceId,
                })
              }
              size="small"
              startIcon={<PlayArrowRoundedIcon />}
              sx={{ borderRadius: 999, px: 1.75 }}
              variant="contained"
            >
              {certificateStatus?.trusted ? t("common.actions.startHttpsProxy") : t("common.actions.startProxy")}
            </Button>
          )}

          <Tooltip arrow title={t("appShell.moreActions")}>
            <IconButton color="inherit" onClick={(event) => setMoreAnchorEl(event.currentTarget)}>
              <MoreVertRoundedIcon />
            </IconButton>
          </Tooltip>

          <Menu
            anchorEl={moreAnchorEl}
            onClose={() => setMoreAnchorEl(null)}
            open={isMoreMenuOpen}
            transformOrigin={{ horizontal: "right", vertical: "top" }}
            anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
          >
            {proxyStatus?.systemProxyEnabled ? (
              <MenuItem
                disabled={isBusy}
                onClick={() => {
                  setMoreAnchorEl(null);
                  disableSystemProxyMutation.mutate(undefined);
                }}
              >
                <ListItemIcon>
                  <LanguageRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t("common.actions.disableSystemProxy")} />
              </MenuItem>
            ) : (
              <MenuItem
                disabled={isBusy || !(proxyStatus?.running ?? false)}
                onClick={() => {
                  setMoreAnchorEl(null);
                  enableSystemProxyMutation.mutate(undefined);
                }}
              >
                <ListItemIcon>
                  <LanguageRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t("common.actions.enableSystemProxy")} />
              </MenuItem>
            )}

            <MenuItem
              disabled={isBusy}
              onClick={() => {
                setMoreAnchorEl(null);
                clearSessionsMutation.mutate();
              }}
            >
              <ListItemIcon>
                <DeleteSweepRoundedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={t("common.actions.clearSessions")} />
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Drawer
        open={navigationExpanded}
        sx={{
          "& .MuiDrawer-paper": {
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            mt: "64px",
            px: 1,
            py: 1.25,
            width: NAVIGATION_WIDTH,
          },
          flexShrink: 0,
          width: navigationExpanded ? NAVIGATION_WIDTH : 0,
        }}
        variant="persistent"
      >
        <Stack sx={{ flex: 1, minHeight: 0 }}>
          <Typography color="text.secondary" sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, px: 1, pb: 0.625, textTransform: "uppercase" }}>
            {t("navigation.workspace")}
          </Typography>
          <List disablePadding sx={{ display: "grid", gap: 0.375 }}>
            {workspaceNavigationItems.map((item) => {
              const selected = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);

              return (
                <ListItemButton
                  component={NavLink}
                  key={item.to}
                  selected={selected}
                  to={item.to}
                  sx={{
                    borderRadius: 2,
                    minHeight: 38,
                    px: 1,
                    position: "relative",
                    transition: "background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease",
                    "&::before": {
                      bgcolor: "primary.main",
                      borderRadius: 999,
                      content: '""',
                      height: 22,
                      left: -6,
                      opacity: selected ? 1 : 0,
                      position: "absolute",
                      top: "50%",
                      transform: "translateY(-50%)",
                      transition: "opacity 160ms ease",
                      width: 3,
                    },
                    "& .MuiListItemIcon-root": {
                      color: selected ? "primary.main" : "text.secondary",
                      minWidth: 32,
                      transition: "color 160ms ease",
                    },
                    "& .MuiListItemText-primary": {
                      color: selected ? "text.primary" : "text.secondary",
                      fontSize: 13.5,
                      fontWeight: selected ? 600 : 500,
                      transition: "color 160ms ease",
                    },
                    "&.Mui-selected": {
                      backgroundColor: "action.selected",
                    },
                    "&.Mui-selected:hover": {
                      backgroundColor: "action.focus",
                    },
                    "&:hover": {
                      backgroundColor: "action.hover",
                      boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
                      transform: "translateX(1px)",
                    },
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={t(item.labelKey)} />
                </ListItemButton>
              );
            })}
          </List>

          <Divider sx={{ my: 1.25 }} />

          <Typography color="text.secondary" sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, px: 1, pb: 0.625, textTransform: "uppercase" }}>
            {t("navigation.manage")}
          </Typography>
          <List disablePadding sx={{ display: "grid", gap: 0.375 }}>
            {topManageItems.map((item) => {
              const selected = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);

              return (
                <ListItemButton
                  component={NavLink}
                  key={item.to}
                  selected={selected}
                  to={item.to}
                  sx={{
                    borderRadius: 2,
                    minHeight: 38,
                    px: 1,
                    position: "relative",
                    transition: "background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease",
                    "&::before": {
                      bgcolor: "primary.main",
                      borderRadius: 999,
                      content: '""',
                      height: 22,
                      left: -6,
                      opacity: selected ? 1 : 0,
                      position: "absolute",
                      top: "50%",
                      transform: "translateY(-50%)",
                      transition: "opacity 160ms ease",
                      width: 3,
                    },
                    "& .MuiListItemIcon-root": {
                      color: selected ? "primary.main" : "text.secondary",
                      minWidth: 32,
                      transition: "color 160ms ease",
                    },
                    "& .MuiListItemText-primary": {
                      color: selected ? "text.primary" : "text.secondary",
                      fontSize: 13.5,
                      fontWeight: selected ? 600 : 500,
                      transition: "color 160ms ease",
                    },
                    "&.Mui-selected": {
                      backgroundColor: "action.selected",
                    },
                    "&.Mui-selected:hover": {
                      backgroundColor: "action.focus",
                    },
                    "&:hover": {
                      backgroundColor: "action.hover",
                      boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
                      transform: "translateX(1px)",
                    },
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={t(item.labelKey)} />
                </ListItemButton>
              );
            })}
          </List>

          <Box sx={{ flex: 1 }} />

          {settingsItem ? (
            <List disablePadding sx={{ pt: 1.25 }}>
              <ListItemButton
                component={NavLink}
                selected={location.pathname.startsWith(settingsItem.to)}
                to={settingsItem.to}
                sx={{
                  borderRadius: 2,
                  minHeight: 38,
                  px: 1,
                  position: "relative",
                  transition: "background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease",
                  "&::before": {
                    bgcolor: "primary.main",
                    borderRadius: 999,
                    content: '""',
                    height: 22,
                    left: -6,
                    opacity: location.pathname.startsWith(settingsItem.to) ? 1 : 0,
                    position: "absolute",
                    top: "50%",
                    transform: "translateY(-50%)",
                    transition: "opacity 160ms ease",
                    width: 3,
                  },
                  "& .MuiListItemIcon-root": {
                    color: location.pathname.startsWith(settingsItem.to) ? "primary.main" : "text.secondary",
                    minWidth: 32,
                  },
                  "& .MuiListItemText-primary": {
                    color: location.pathname.startsWith(settingsItem.to) ? "text.primary" : "text.secondary",
                    fontSize: 13.5,
                    fontWeight: location.pathname.startsWith(settingsItem.to) ? 600 : 500,
                  },
                  "&.Mui-selected": {
                    backgroundColor: "action.selected",
                  },
                  "&.Mui-selected:hover": {
                    backgroundColor: "action.focus",
                  },
                  "&:hover": {
                    backgroundColor: "action.hover",
                    boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
                    transform: "translateX(1px)",
                  },
                }}
              >
                <ListItemIcon>{settingsItem.icon}</ListItemIcon>
                <ListItemText primary={t(settingsItem.labelKey)} />
              </ListItemButton>
            </List>
          ) : null}
        </Stack>
      </Drawer>

      <Box
        component="main"
        sx={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          mt: "64px",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>
          <Outlet />
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
            label={t("appShell.workspaceStatus", { workspaceId })}
            onClick={openWorkspaceDialog}
            title={t("appShell.switchActiveWorkspace")}
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
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleWorkspaceSwitch();
          }}
        >
          <DialogTitle>{t("appShell.switchWorkspaceTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography color="text.secondary" variant="body2">
                {proxyStatus?.running
                  ? t("appShell.switchWorkspaceRestartHint")
                  : t("appShell.switchWorkspaceSetHint")}
              </Typography>
              <OutlinedInput
                autoFocus
                error={Boolean(workspaceDialogError)}
                onChange={(event) => {
                  setWorkspaceDraft(event.target.value);
                  if (workspaceDialogError) {
                    setWorkspaceDialogError(null);
                  }
                }}
                placeholder="default"
                value={workspaceDraft}
              />
              {workspaceDialogError ? (
                <Typography color="error" variant="caption">
                  {workspaceDialogError}
                </Typography>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setWorkspaceDialogOpen(false)}>{t("common.actions.cancel")}</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {proxyStatus?.running ? t("common.actions.applyAndRestart") : t("common.actions.switchWorkspace")}
            </Button>
          </DialogActions>
        </Box>
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
