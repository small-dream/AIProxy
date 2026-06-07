import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CropSquareRoundedIcon from "@mui/icons-material/CropSquareRounded";
import MinimizeRoundedIcon from "@mui/icons-material/MinimizeRounded";
import { Box, Button, Divider, IconButton, Menu, MenuItem, Stack } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

import { WINDOWS_MENU_DEFINITIONS } from "@/components/layout/app-shell-windows-menu.definitions";

export const WINDOWS_TOP_CONTROLS_HEIGHT = 40;

type AppShellWindowsMenuBarProps = {
  centerControls: ReactNode;
  onMenuAction: (menuId: string) => void;
};

export function AppShellWindowsMenuBar({
  centerControls,
  onMenuAction,
}: AppShellWindowsMenuBarProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);

  function openMenu(menuId: string, event: MouseEvent<HTMLButtonElement>) {
    setOpenMenuId(menuId);
    setMenuAnchorEl(event.currentTarget);
  }

  function closeMenu() {
    setOpenMenuId(null);
    setMenuAnchorEl(null);
  }

  function handleMenuItemClick(menuId: string) {
    closeMenu();
    onMenuAction(menuId);
  }

  return (
    <Box
      sx={{
        alignItems: "center",
        backdropFilter: "blur(14px)",
        bgcolor: (theme) =>
          alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.9 : 0.96),
        borderBottom: "1px solid",
        borderColor: (theme) =>
          alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.62 : 0.78),
        display: "flex",
        height: WINDOWS_TOP_CONTROLS_HEIGHT,
        left: 0,
        px: 1,
        position: "fixed",
        right: 0,
        top: 0,
        zIndex: (theme) => theme.zIndex.appBar + 1,
      }}
    >
      <Box
        data-tauri-drag-region
        sx={{
          inset: 0,
          position: "absolute",
        }}
      />

      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          flex: "0 0 auto",
          gap: 0.25,
          height: "100%",
          minWidth: 360,
          position: "relative",
          zIndex: 1,
        }}
      >
        {WINDOWS_MENU_DEFINITIONS.map((menu) => (
          <Button
            key={menu.id}
            aria-haspopup="menu"
            onClick={(event) => openMenu(menu.id, event)}
            size="small"
            sx={{
              borderRadius: 1,
              color: "text.primary",
              fontSize: 13,
              fontWeight: 400,
              minWidth: 0,
              px: 0.9,
              py: 0.5,
              textTransform: "none",
            }}
          >
            {menu.label}
          </Button>
        ))}
      </Box>

      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          inset: 0,
          justifyContent: "center",
          pointerEvents: "none",
          position: "absolute",
          zIndex: 1,
        }}
      >
        <Box sx={{ pointerEvents: "auto" }}>{centerControls}</Box>
      </Box>

      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          height: "100%",
          marginLeft: "auto",
          position: "relative",
          zIndex: 1,
        }}
      >
        <WindowControls onMenuAction={onMenuAction} />
      </Box>

      {WINDOWS_MENU_DEFINITIONS.map((menu) => (
        <Menu
          key={menu.id}
          anchorEl={menuAnchorEl}
          open={openMenuId === menu.id}
          onClose={closeMenu}
          MenuListProps={{
            dense: true,
          }}
        >
          {menu.items.map((item, index) =>
            "kind" in item ? (
              <Divider key={`${menu.id}-divider-${index}`} />
            ) : (
              <MenuItem key={item.id} onClick={() => handleMenuItemClick(item.id)}>
                {item.label}
              </MenuItem>
            ),
          )}
        </Menu>
      ))}
    </Box>
  );
}

type WindowControlsProps = {
  onMenuAction: (menuId: string) => void;
};

function WindowControls({ onMenuAction }: WindowControlsProps) {
  const controls = [
    {
      icon: <MinimizeRoundedIcon />,
      id: "window_minimize",
      label: "Minimize",
    },
    {
      icon: <CropSquareRoundedIcon />,
      id: "window_toggle_maximize",
      label: "Maximize",
    },
    {
      icon: <CloseRoundedIcon />,
      id: "window_close",
      label: "Close",
    },
  ];

  return (
    <Stack direction="row" sx={{ height: "100%" }}>
      {controls.map((control) => (
        <IconButton
          key={control.id}
          aria-label={control.label}
          onClick={() => onMenuAction(control.id)}
          sx={(theme) => ({
            borderRadius: 0,
            color: "text.secondary",
            height: "100%",
            width: 46,
            "& .MuiSvgIcon-root": {
              fontSize: control.id === "window_minimize" ? 18 : 16,
            },
            "&:hover": {
              bgcolor:
                control.id === "window_close"
                  ? theme.palette.error.main
                  : alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.14 : 0.08),
              color:
                control.id === "window_close"
                  ? theme.palette.error.contrastText
                  : theme.palette.text.primary,
            },
          })}
        >
          {control.icon}
        </IconButton>
      ))}
    </Stack>
  );
}
