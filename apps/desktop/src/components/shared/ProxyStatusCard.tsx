import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import { Button, Chip, Stack, Typography } from "@mui/material";

import { SectionCard } from "./SectionCard";

type ProxyStatusCardProps = {
  busy?: boolean;
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
  port: number;
  sslEnabled: boolean;
  workspaceId: string;
};

export function ProxyStatusCard({
  busy = false,
  isRunning,
  onStart,
  onStop,
  port,
  sslEnabled,
  workspaceId,
}: ProxyStatusCardProps) {
  return (
    <SectionCard
      description="This card is backed by the shared bootstrap command contract and will later reflect live runtime data."
      title="Proxy Runtime"
      toolbar={
        isRunning ? (
          <Button
            color="error"
            disabled={busy}
            onClick={onStop}
            startIcon={<StopRoundedIcon />}
            variant="outlined"
          >
            Stop Proxy
          </Button>
        ) : (
          <Button disabled={busy} onClick={onStart} startIcon={<PlayArrowRoundedIcon />} variant="contained">
            Start Proxy
          </Button>
        )
      }
    >
      <Stack spacing={1.25}>
        <Typography variant="body2">Workspace: {workspaceId}</Typography>
        <Typography variant="body2">Port: {port}</Typography>
        <Stack direction="row" spacing={1}>
          <Chip color={isRunning ? "success" : "default"} label={isRunning ? "Running" : "Idle"} size="small" />
          <Chip color={sslEnabled ? "warning" : "default"} label={sslEnabled ? "SSL On" : "SSL Off"} size="small" />
        </Stack>
      </Stack>
    </SectionCard>
  );
}

