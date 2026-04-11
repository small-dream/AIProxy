import MenuIcon from "@mui/icons-material/Menu";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import { DEFAULT_PROXY_PORT } from "@pharles/shared-types";
import {
  AppBar,
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  OutlinedInput,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { navigationItems } from "@/features/navigation/navigation-items";
import { getProxyStatusPresentation } from "@/features/proxy-status/proxy-status.helpers";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";

const NAVIGATION_WIDTH = 264;

export function AppShell() {
  const location = useLocation();
  const navigationExpanded = useAppShellStore((state) => state.navigationExpanded);
  const toggleNavigation = useAppShellStore((state) => state.toggleNavigation);
  const { data: proxyStatus } = useProxyStatus();
  const proxyPresentation = getProxyStatusPresentation(proxyStatus);

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
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
        <Toolbar sx={{ gap: 2 }}>
          <IconButton color="inherit" onClick={toggleNavigation}>
            <MenuIcon />
          </IconButton>

          <Stack spacing={0.25}>
            <Typography variant="h6">Pharles</Typography>
            <Typography color="text.secondary" variant="caption">
              Developer proxy workbench
            </Typography>
          </Stack>

          <Chip color={proxyPresentation.chipColor} label={proxyPresentation.label} />

          <OutlinedInput
            placeholder="Search sessions, domains, or rules"
            size="small"
            startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
            sx={{ ml: "auto", width: 320, bgcolor: "background.paper" }}
          />

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
          minWidth: 0,
        }}
      >
        <Box sx={{ flex: 1, p: 3 }}>
          <Outlet />
        </Box>

        <Divider />

        <Stack
          alignItems="center"
          direction="row"
          justifyContent="space-between"
          spacing={2}
          sx={{
            px: 3,
            py: 1.5,
          }}
        >
          <Typography color="text.secondary" variant="body2">
            Workspace: {proxyStatus?.activeWorkspaceId ?? "default"}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Port {proxyStatus?.port ?? DEFAULT_PROXY_PORT} | SSL {proxyStatus?.sslEnabled ? "enabled" : "disabled"} |
            {" "}System proxy {proxyStatus?.systemProxyEnabled ? "on" : "off"}
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
}
