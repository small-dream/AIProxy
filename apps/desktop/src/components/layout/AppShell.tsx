import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import MenuIcon from "@mui/icons-material/Menu";
import PauseCircleOutlineRoundedIcon from "@mui/icons-material/PauseCircleOutlineRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@pharles/shared-types";
import {
  AppBar,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { navigationItems } from "@/features/navigation/navigation-items";
import { getProxyStatusPresentation } from "@/features/proxy-status/proxy-status.helpers";
import {
  useClearSessions,
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";

const NAVIGATION_WIDTH = 264;

export function AppShell() {
  const location = useLocation();
  const navigationExpanded = useAppShellStore((state) => state.navigationExpanded);
  const toggleNavigation = useAppShellStore((state) => state.toggleNavigation);
  const { data: proxyStatus } = useProxyStatus();
  const { data: certificateStatus } = useCertificateStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const clearSessionsMutation = useClearSessions();
  const proxyPresentation = getProxyStatusPresentation(proxyStatus);
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const isBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending ||
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending ||
    clearSessionsMutation.isPending;

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
        <Toolbar sx={{ gap: 1.25 }}>
          <IconButton color="inherit" onClick={toggleNavigation}>
            <MenuIcon />
          </IconButton>

          <Stack spacing={0.25} sx={{ mr: 1 }}>
            <Typography variant="h6">Pharles</Typography>
            <Typography color="text.secondary" variant="caption">
              Developer proxy workbench
            </Typography>
          </Stack>

          {proxyStatus?.running ? (
            <Button
              color="error"
              disabled={isBusy}
              onClick={() => stopProxyMutation.mutate(workspaceId)}
              size="small"
              startIcon={<StopRoundedIcon />}
              variant="outlined"
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
              variant="contained"
            >
              {certificateStatus?.trusted ? "Start HTTPS Proxy" : "Start Proxy"}
            </Button>
          )}

          {proxyStatus?.systemProxyEnabled ? (
            <Button
              color="warning"
              disabled={isBusy}
              onClick={() => disableSystemProxyMutation.mutate(undefined)}
              size="small"
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              Disable System Proxy
            </Button>
          ) : (
            <Button
              disabled={isBusy || !(proxyStatus?.running ?? false)}
              onClick={() => enableSystemProxyMutation.mutate(undefined)}
              size="small"
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              Enable System Proxy
            </Button>
          )}

          <Button
            disabled={isBusy}
            onClick={() => clearSessionsMutation.mutate()}
            size="small"
            startIcon={<DeleteSweepRoundedIcon />}
            variant="text"
          >
            Clear Sessions
          </Button>

          <Chip color={proxyPresentation.chipColor} label={proxyPresentation.label} sx={{ ml: "auto" }} />

          <IconButton color="inherit" component={NavLink} to="/settings">
            <SettingsRoundedIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Drawer
        open={navigationExpanded}
        sx={{
          "& .MuiDrawer-paper": {
            boxSizing: "border-box",
            mt: "64px",
            width: NAVIGATION_WIDTH,
          },
          flexShrink: 0,
          width: navigationExpanded ? NAVIGATION_WIDTH : 0,
        }}
        variant="persistent"
      >
        <List disablePadding>
          {navigationItems.map((item) => {
            const selected = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);

            return (
              <ListItemButton component={NavLink} key={item.to} selected={selected} to={item.to}>
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            );
          })}
        </List>
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
        <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden", p: 2 }}>
          <Outlet />
        </Box>

        <Divider />

        <Stack
          alignItems={{ lg: "center", xs: "stretch" }}
          direction={{ lg: "row", xs: "column" }}
          spacing={1}
          sx={{
            bgcolor: "background.paper",
            px: 2,
            py: 1,
          }}
        >
          <Stack alignItems={{ lg: "center", xs: "stretch" }} direction={{ md: "row", xs: "column" }} spacing={1}>
            <Chip
              color={proxyStatus?.running ? "success" : "default"}
              icon={<PauseCircleOutlineRoundedIcon />}
              label={proxyStatus?.running ? "Recording" : "Idle"}
              size="small"
            />
            <Chip label={`Workspace ${workspaceId}`} size="small" variant="outlined" />
            <Chip label={`Port ${port}`} size="small" variant="outlined" />
            <Chip
              color={proxyStatus?.systemProxyEnabled ? "primary" : "default"}
              label={proxyStatus?.systemProxyEnabled ? "System Proxy On" : "System Proxy Off"}
              size="small"
              variant={proxyStatus?.systemProxyEnabled ? "filled" : "outlined"}
            />
            <Chip
              color={proxyStatus?.sslEnabled ? "warning" : "default"}
              label={proxyStatus?.sslEnabled ? "SSL On" : "SSL Off"}
              size="small"
              variant="outlined"
            />
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
