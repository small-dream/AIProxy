import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import PauseCircleOutlineRoundedIcon from "@mui/icons-material/PauseCircleOutlineRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { Button, Chip, OutlinedInput, Paper, Stack, Typography } from "@mui/material";

export type SystemProxyActionState = "failed" | "idle" | "requesting" | "succeeded";

type CaptureControlStripProps = {
  busy: boolean;
  isRunning: boolean;
  onDisableSystemProxy: () => void;
  onEnableSystemProxy: () => void;
  onSearchChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
  port: number;
  searchValue: string;
  sessionCount: number;
  sslEnabled: boolean;
  systemProxyActionMessage?: string;
  systemProxyActionState: SystemProxyActionState;
  systemProxyEnabled: boolean;
  workspaceId: string;
};

export function CaptureControlStrip({
  busy,
  isRunning,
  onDisableSystemProxy,
  onEnableSystemProxy,
  onSearchChange,
  onStart,
  onStop,
  port,
  searchValue,
  sessionCount,
  sslEnabled,
  systemProxyActionMessage,
  systemProxyActionState,
  systemProxyEnabled,
  workspaceId,
}: CaptureControlStripProps) {
  const systemProxyStatusText = getSystemProxyStatusText(systemProxyActionState, systemProxyActionMessage);

  return (
    <Paper
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        px: 2,
        py: 1.5,
      }}
      variant="outlined"
    >
      <Stack direction={{ lg: "row", xs: "column" }} spacing={2}>
        <Stack flexWrap="wrap" direction="row" spacing={1} useFlexGap>
          <Chip
            color={isRunning ? "success" : "default"}
            icon={<PauseCircleOutlineRoundedIcon />}
            label={isRunning ? "Recording" : "Idle"}
            size="small"
          />
          <Chip label={`Workspace ${workspaceId}`} size="small" variant="outlined" />
          <Chip label={`Port ${port}`} size="small" variant="outlined" />
          <Chip
            color={systemProxyEnabled ? "primary" : "default"}
            label={systemProxyEnabled ? "System Proxy On" : "System Proxy Off"}
            size="small"
            variant={systemProxyEnabled ? "filled" : "outlined"}
          />
          <Chip
            color={sslEnabled ? "warning" : "default"}
            label={sslEnabled ? "SSL On" : "SSL Off"}
            size="small"
            variant="outlined"
          />
          <Chip label={`${sessionCount} sessions`} size="small" variant="outlined" />
        </Stack>

        <Stack
          alignItems={{ lg: "center", xs: "stretch" }}
          direction={{ md: "row", xs: "column" }}
          spacing={1.25}
          sx={{ ml: "auto" }}
        >
          {systemProxyEnabled ? (
            <Button
              color="warning"
              disabled={busy}
              onClick={onDisableSystemProxy}
              size="small"
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              Disable System Proxy
            </Button>
          ) : (
            <Button
              disabled={busy || !isRunning}
              onClick={onEnableSystemProxy}
              size="small"
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              Enable System Proxy
            </Button>
          )}

          {isRunning ? (
            <Button
              color="error"
              disabled={busy}
              onClick={onStop}
              size="small"
              startIcon={<StopRoundedIcon />}
              variant="outlined"
            >
              Stop Proxy
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={onStart}
              size="small"
              startIcon={<PlayArrowRoundedIcon />}
              variant="contained"
            >
              Start Proxy
            </Button>
          )}

          <OutlinedInput
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Filter hosts, paths, methods, or status"
            size="small"
            sx={{ minWidth: { lg: 320, xs: "100%" } }}
            value={searchValue}
          />
        </Stack>
      </Stack>

      <Typography color="text.secondary" sx={{ mt: 1.5 }} variant="caption">
        Capture workspace aligned to a host-grouped traffic explorer and inspector flow.
      </Typography>

      <Typography
        color={systemProxyActionState === "failed" ? "error.main" : "text.secondary"}
        sx={{ display: "block", mt: 0.75 }}
        variant="caption"
      >
        {systemProxyStatusText}
      </Typography>
    </Paper>
  );
}

function getSystemProxyStatusText(
  state: SystemProxyActionState,
  message?: string,
): string {
  if (state === "requesting") {
    return "System proxy action in progress...";
  }

  if (state === "succeeded") {
    return message ?? "Last system proxy action succeeded.";
  }

  if (state === "failed") {
    return message ?? "Last system proxy action failed.";
  }

  return message ?? "System proxy has not been requested in this session yet.";
}
