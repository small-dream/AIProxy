import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { Box, Stack } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

import {
  AppShellWindowsMenuBar,
  WINDOWS_TOP_CONTROLS_HEIGHT,
} from "@/components/layout/AppShellWindowsMenuBar";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { UpdateAvailableButton } from "@/features/updater/UpdateAvailableButton";

const TOP_CONTROLS_VERTICAL_OFFSET = 2;
const MACOS_WINDOW_CONTROLS_SAFE_WIDTH = 112;

type AppShellTopControlsProps = {
  headerActions: ReactNode | null;
  isProxyBusy: boolean;
  macosTitlebarEnabled: boolean;
  onStartProxy: () => void;
  onStopProxy: () => void;
  onMenuAction: (menuId: string) => void;
  onSystemProxyToggle: () => void;
  proxyRunning: boolean;
  startProxyLabel: string;
  stopProxyLabel: string;
  systemProxyActionDisabled: boolean;
  systemProxyEnabled: boolean;
  systemProxyOffLabel: string;
  systemProxyOnLabel: string;
  workspaceConfigUnavailable?: boolean;
};

export function AppShellTopControls({
  headerActions,
  isProxyBusy,
  macosTitlebarEnabled,
  onStartProxy,
  onStopProxy,
  onMenuAction,
  onSystemProxyToggle,
  proxyRunning,
  startProxyLabel,
  stopProxyLabel,
  systemProxyActionDisabled,
  systemProxyEnabled,
  systemProxyOffLabel,
  systemProxyOnLabel,
  workspaceConfigUnavailable = false,
}: AppShellTopControlsProps) {
  function renderControls(variant: "floating" | "commandBar") {
    return (
      <Stack
        direction="row"
        spacing={variant === "floating" ? 1.25 : 0.75}
        sx={[
          {
            alignItems: "center",
          },
          (theme) => ({
            ...(variant === "floating"
              ? {
                  backdropFilter: "blur(18px)",
                  bgcolor: alpha(
                    theme.palette.background.paper,
                    theme.palette.mode === "dark" ? 0.68 : 0.76,
                  ),
                  border: "1px solid",
                  borderColor: alpha(
                    theme.palette.divider,
                    theme.palette.mode === "dark" ? 0.58 : 0.78,
                  ),
                  borderRadius: 999,
                  boxShadow:
                    theme.palette.mode === "dark"
                      ? "0 8px 22px rgba(0, 0, 0, 0.20)"
                      : "0 8px 22px rgba(15, 23, 42, 0.06)",
                  px: 0.4,
                  py: 0.25,
                }
              : {
                  bgcolor: "transparent",
                  borderRadius: 1,
                  px: 0,
                  py: 0,
                }),
            flexWrap: "wrap",
            justifyContent: "center",
            rowGap: 0.5,
          }),
        ]}
      >
        {proxyRunning ? (
          <TopBarActionButton
            disabled={isProxyBusy}
            icon={<StopRoundedIcon />}
            label={stopProxyLabel}
            onClick={onStopProxy}
            tone="error"
            variant="filled"
          />
        ) : (
          <TopBarActionButton
            disabled={isProxyBusy || workspaceConfigUnavailable}
            icon={<PlayArrowRoundedIcon />}
            label={startProxyLabel}
            onClick={onStartProxy}
            tone="primary"
            variant="filled"
          />
        )}
        <TopBarActionButton
          ariaPressed={systemProxyEnabled}
          disabled={systemProxyActionDisabled}
          icon={<LanguageRoundedIcon />}
          label={systemProxyEnabled ? systemProxyOffLabel : systemProxyOnLabel}
          onClick={onSystemProxyToggle}
          tone={systemProxyEnabled ? "success" : "default"}
          variant={systemProxyEnabled ? "filled" : "outlined"}
        />
        {headerActions}
      </Stack>
    );
  }

  if (macosTitlebarEnabled) {
    return (
      <Box
        sx={{
          backdropFilter: "blur(14px)",
          bgcolor: "transparent",
          height: 38,
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
            left: 0,
            justifyContent: "center",
            pointerEvents: "none",
            position: "absolute",
            right: 0,
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
            {renderControls("floating")}
          </Box>
        </Box>
        <Box
          sx={{
            alignItems: "center",
            display: "flex",
            height: "100%",
            pointerEvents: "auto",
            position: "absolute",
            right: MACOS_WINDOW_CONTROLS_SAFE_WIDTH,
            top: 0,
            transform: `translateY(${TOP_CONTROLS_VERTICAL_OFFSET}px)`,
          }}
        >
          <UpdateAvailableButton />
        </Box>
      </Box>
    );
  }

  return (
    <AppShellWindowsMenuBar
      centerControls={renderControls("commandBar")}
      onMenuAction={onMenuAction}
      rightControls={<UpdateAvailableButton />}
    />
  );
}

export const NON_MACOS_TOP_CONTROLS_HEIGHT = WINDOWS_TOP_CONTROLS_HEIGHT;
