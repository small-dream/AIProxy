import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
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
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { navigationItems } from "@/features/navigation/navigation-items";
import {
  useClearSessions,
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";

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
          bgcolor: alpha("#2962FF", 0.08),
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Something went wrong. Please try again.";
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationExpanded = useAppShellStore((state) => state.navigationExpanded);
  const toggleNavigation = useAppShellStore((state) => state.toggleNavigation);
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
  const sslLabel = proxyStatus?.sslEnabled ? "SSL On" : certificateStatus?.trusted ? "SSL Ready" : "SSL Setup";
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
      setWorkspaceDialogError("Workspace ID is required.");
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
      setWorkspaceDialogError(getErrorMessage(error));
    }
  }

  async function handlePortApply() {
    const nextPort = Number.parseInt(portDraft.trim(), 10);

    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setPortDialogError("Enter a valid TCP port between 1 and 65535.");
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
      setPortDialogError(getErrorMessage(error));
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
              Desktop proxy workbench
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
              Stop Proxy
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
              {certificateStatus?.trusted ? "Start HTTPS Proxy" : "Start Proxy"}
            </Button>
          )}

          <Tooltip arrow title="More actions">
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
                <ListItemText primary="Disable System Proxy" />
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
                <ListItemText primary="Enable System Proxy" />
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
              <ListItemText primary="Clear Sessions" />
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
            Workspace
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
                      backgroundColor: alpha("#2962FF", 0.08),
                    },
                    "&.Mui-selected:hover": {
                      backgroundColor: alpha("#2962FF", 0.12),
                    },
                    "&:hover": {
                      backgroundColor: "action.hover",
                      boxShadow: "0 1px 2px rgba(23, 32, 42, 0.08)",
                      transform: "translateX(1px)",
                    },
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              );
            })}
          </List>

          <Divider sx={{ my: 1.25 }} />

          <Typography color="text.secondary" sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, px: 1, pb: 0.625, textTransform: "uppercase" }}>
            Manage
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
                      backgroundColor: alpha("#2962FF", 0.08),
                    },
                    "&.Mui-selected:hover": {
                      backgroundColor: alpha("#2962FF", 0.12),
                    },
                    "&:hover": {
                      backgroundColor: "action.hover",
                      boxShadow: "0 1px 2px rgba(23, 32, 42, 0.08)",
                      transform: "translateX(1px)",
                    },
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} />
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
                    backgroundColor: alpha("#2962FF", 0.08),
                  },
                  "&.Mui-selected:hover": {
                    backgroundColor: alpha("#2962FF", 0.12),
                  },
                  "&:hover": {
                    backgroundColor: "action.hover",
                    boxShadow: "0 1px 2px rgba(23, 32, 42, 0.08)",
                    transform: "translateX(1px)",
                  },
                }}
              >
                <ListItemIcon>{settingsItem.icon}</ListItemIcon>
                <ListItemText primary={settingsItem.label} />
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
            label={proxyStatus?.running ? "Recording" : "Idle"}
          />

          <StatusSeparator />

          <StatusItem
            icon={<BoltRoundedIcon />}
            label={`Workspace ${workspaceId}`}
            onClick={openWorkspaceDialog}
            title="Switch the active workspace"
          />

          <StatusSeparator />

          <StatusItem
            icon={<SettingsEthernetRoundedIcon />}
            label={`:${port}`}
            monospaced
            onClick={openPortDialog}
            title="Change the listening port"
          />

          <StatusSeparator />

          <StatusItem
            active={proxyStatus?.systemProxyEnabled ?? false}
            icon={<LanguageRoundedIcon />}
            label={proxyStatus?.systemProxyEnabled ? "System Proxy On" : "System Proxy Off"}
            onClick={() => {
              void handleSystemProxyToggle();
            }}
            title={
              proxyStatus?.systemProxyEnabled
                ? "Disable the system proxy"
                : proxyStatus?.running
                  ? "Enable the system proxy"
                  : "Start the proxy before enabling the system proxy"
            }
          />

          <StatusSeparator />

          <StatusItem
            active={Boolean(proxyStatus?.sslEnabled || certificateStatus?.trusted)}
            icon={<LockRoundedIcon />}
            label={sslLabel}
            onClick={() => navigate("/certificates")}
            title="Open the Certificates page"
          />
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
          <DialogTitle>Switch Workspace</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography color="text.secondary" variant="body2">
                {proxyStatus?.running
                  ? "Changing the workspace restarts the proxy and starts a fresh capture context."
                  : "Set the active workspace ID for the next capture session."}
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
            <Button onClick={() => setWorkspaceDialogOpen(false)}>Cancel</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {proxyStatus?.running ? "Apply & Restart" : "Switch Workspace"}
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
          <DialogTitle>Change Proxy Port</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography color="text.secondary" variant="body2">
                {proxyStatus?.running
                  ? "Port changes restart the proxy and rebind the listener immediately."
                  : "Port changes are applied by starting the proxy on the new port."}
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
            <Button onClick={() => setPortDialogOpen(false)}>Cancel</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {proxyStatus?.running ? "Apply & Restart" : "Start on New Port"}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}
