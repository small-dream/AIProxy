import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import { Button, Chip, Stack, Typography } from "@mui/material";

import { useI18n } from "@/i18n";
import { SectionCard } from "./SectionCard";

type ProxyStatusCardProps = {
  busy?: boolean;
  isRunning: boolean;
  onDisableSystemProxy: () => void;
  onEnableSystemProxy: () => void;
  onStart: () => void;
  onStop: () => void;
  port: number;
  systemProxyEnabled: boolean;
  sslEnabled: boolean;
  workspaceId: string;
};

export function ProxyStatusCard({
  busy = false,
  isRunning,
  onDisableSystemProxy,
  onEnableSystemProxy,
  onStart,
  onStop,
  port,
  systemProxyEnabled,
  sslEnabled,
  workspaceId,
}: ProxyStatusCardProps) {
  const { t } = useI18n();

  return (
    <SectionCard
      description={t("proxyRuntime.description")}
      title={t("proxyRuntime.title")}
      toolbar={
        <Stack direction="row" spacing={1}>
          {systemProxyEnabled ? (
            <Button
              color="warning"
              disabled={busy}
              onClick={onDisableSystemProxy}
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              {t("common.actions.disableSystemProxy")}
            </Button>
          ) : (
            <Button
              disabled={busy || !isRunning}
              onClick={onEnableSystemProxy}
              startIcon={<LanguageRoundedIcon />}
              variant="outlined"
            >
              {t("common.actions.enableSystemProxy")}
            </Button>
          )}

          {isRunning ? (
            <Button
              color="error"
              disabled={busy}
              onClick={onStop}
              startIcon={<StopRoundedIcon />}
              variant="outlined"
            >
              {t("common.actions.stopProxy")}
            </Button>
          ) : (
            <Button disabled={busy} onClick={onStart} startIcon={<PlayArrowRoundedIcon />} variant="contained">
              {t("common.actions.startProxy")}
            </Button>
          )}
        </Stack>
      }
    >
      <Stack spacing={1.25}>
        <Typography variant="body2">{t("common.labels.workspace")}: {workspaceId}</Typography>
        <Typography variant="body2">{t("common.labels.port")}: {port}</Typography>
        <Stack direction="row" spacing={1}>
          <Chip color={isRunning ? "success" : "default"} label={isRunning ? t("common.states.running") : t("common.states.idle")} size="small" />
          <Chip
            color={systemProxyEnabled ? "primary" : "default"}
            label={systemProxyEnabled ? t("proxyRuntime.systemProxyOn") : t("proxyRuntime.systemProxyOff")}
            size="small"
          />
          <Chip color={sslEnabled ? "warning" : "default"} label={sslEnabled ? t("proxyRuntime.sslOn") : t("proxyRuntime.sslOff")} size="small" />
        </Stack>
      </Stack>
    </SectionCard>
  );
}
