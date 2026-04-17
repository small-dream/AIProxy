import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { Box, Stack } from "@mui/material";
import type { ReactNode } from "react";

import { TopBarActionButton } from "@/components/shared/TopBarActionButton";

const TOP_CONTROLS_VERTICAL_OFFSET = 2;
const TOP_CONTROLS_HORIZONTAL_GUTTER = 24;
const MACOS_WINDOW_CONTROLS_SAFE_WIDTH = 112;

type AppShellTopControlsProps = {
  headerActions: ReactNode | null;
  isProxyBusy: boolean;
  macosTitlebarEnabled: boolean;
  onStartProxy: () => void;
  onStopProxy: () => void;
  onSystemProxyToggle: () => void;
  proxyRunning: boolean;
  startProxyLabel: string;
  stopProxyLabel: string;
  systemProxyActionDisabled: boolean;
  systemProxyEnabled: boolean;
  systemProxyOffLabel: string;
  systemProxyOnLabel: string;
};

export function AppShellTopControls({
  headerActions,
  isProxyBusy,
  macosTitlebarEnabled,
  onStartProxy,
  onStopProxy,
  onSystemProxyToggle,
  proxyRunning,
  startProxyLabel,
  stopProxyLabel,
  systemProxyActionDisabled,
  systemProxyEnabled,
  systemProxyOffLabel,
  systemProxyOnLabel,
}: AppShellTopControlsProps) {
  const controls = (
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
      <Stack direction="row" spacing={1.25}>
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
            disabled={isProxyBusy}
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
      </Stack>

      {headerActions}
    </Stack>
  );

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
            {controls}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
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
        {controls}
      </Box>
    </Box>
  );
}
