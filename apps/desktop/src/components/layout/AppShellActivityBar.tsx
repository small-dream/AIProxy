import { Box, Divider, Drawer, List, ListItemButton, ListItemIcon, Stack, Tooltip } from "@mui/material";
import { NavLink } from "react-router-dom";

import { navigationItems } from "@/features/navigation/navigation-items";
import { useI18n } from "@/i18n";

const ACTIVITY_BAR_WIDTH = 48;
const ACTIVITY_BAR_BG = "#2c2c2c";
const ACTIVITY_BAR_ICON = "rgba(255, 255, 255, 0.42)";
const ACTIVITY_BAR_ICON_ACTIVE = "#f5f5f5";
const ACTIVITY_BAR_DIVIDER = "rgba(255, 255, 255, 0.1)";

type AppShellActivityBarProps = {
  locationPathname: string;
  pendingBreakpointCount: number;
  topLayoutHeight: number;
};

export function AppShellActivityBar({
  locationPathname,
  pendingBreakpointCount,
  topLayoutHeight,
}: AppShellActivityBarProps) {
  const { t } = useI18n();
  const workspaceNavigationItems = navigationItems.filter((item) => item.group === "workspace");
  const manageNavigationItems = navigationItems.filter((item) => item.group === "manage");
  const settingsItem = manageNavigationItems.find((item) => item.to === "/settings");
  const topManageItems = manageNavigationItems.filter((item) => item.to !== "/settings");

  function renderNavigationIcon(item: typeof navigationItems[number], options?: { badgeContent?: number }) {
    const selected = item.to === "/" ? locationPathname === "/" : locationPathname.startsWith(item.to);

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
            minHeight: 52,
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
                  border: `2px solid ${ACTIVITY_BAR_BG}`,
                  bottom: -3,
                  color: "primary.contrastText",
                  display: "flex",
                  fontSize: 11,
                  fontWeight: 700,
                  height: 22,
                  justifyContent: "center",
                  minWidth: 22,
                  position: "absolute",
                  px: 0.5,
                  right: -16,
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
  );
}
