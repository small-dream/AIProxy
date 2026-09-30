import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, keyframes } from "@mui/material/styles";
import { useEffect, useState } from "react";

import { formatRecordingDuration } from "@/features/proxy-status/proxy-status.helpers";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

const TICK_INTERVAL_MS = 1_000;

const recordingPulse = keyframes`
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
  100% { opacity: 1; transform: scale(1); }
`;

type RecordingDurationIndicatorProps = {
  /** RFC3339 timestamp from `ProxyStatus.startedAt`; invalid input hides the indicator. */
  startedAt: string;
};

// Ticking elapsed-time readout next to the stop button while recording, so an
// active capture is obvious at a glance. Isolated in its own component so the
// 1s tick re-renders nothing else in the top controls.
export function RecordingDurationIndicator({ startedAt }: RecordingDurationIndicatorProps) {
  const { t } = useI18n();
  const startedAtMs = Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  if (Number.isNaN(startedAtMs)) {
    return null;
  }

  const duration = formatRecordingDuration(now - startedAtMs);

  return (
    <Tooltip arrow title={t("appShell.recordingElapsed", { duration })}>
      <Stack
        aria-label={t("appShell.recordingElapsed", { duration })}
        direction="row"
        spacing={0.75}
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.2 : 0.08),
          border: "1px solid",
          borderColor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.32 : 0.18),
          borderRadius: 999,
          height: 32,
          px: 1.25,
        })}
      >
        <Box
          sx={(theme) => ({
            animation: `${recordingPulse} 1.6s ease-in-out infinite`,
            bgcolor: theme.palette.error.main,
            borderRadius: "50%",
            flexShrink: 0,
            height: 8,
            width: 8,
            "@media (prefers-reduced-motion: reduce)": {
              animation: "none",
            },
          })}
        />
        <Typography
          component="span"
          sx={(theme) => ({
            color: theme.palette.error.main,
            fontFamily: fontFamilies.mono,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
          })}
        >
          {duration}
        </Typography>
      </Stack>
    </Tooltip>
  );
}
