import { Box, Stack, Tooltip, Typography } from "@mui/material";
import type { TimingBreakdown } from "@aiproxy/shared-types";

import { useI18n, type TranslationKey } from "@/i18n";

type WaterfallPhase = {
  color: string;
  labelKey: TranslationKey;
  valueMs: number | undefined;
};

const PHASE_COLORS = {
  dns: "#6baed6",
  connect: "#fd8d3c",
  tls: "#74c476",
  send: "#9e9e9e",
  wait: "#e6550d",
  download: "#756bb1",
} as const;

const GAP_MARKER_WIDTH = 2;

const PHASE_KEYS = [
  { color: PHASE_COLORS.dns, labelKey: "inspector.waterfall.dns" as TranslationKey, field: "dnsMs" as const },
  { color: PHASE_COLORS.connect, labelKey: "inspector.waterfall.connect" as TranslationKey, field: "connectMs" as const },
  { color: PHASE_COLORS.tls, labelKey: "inspector.waterfall.tls" as TranslationKey, field: "tlsMs" as const },
  { color: PHASE_COLORS.send, labelKey: "inspector.waterfall.send" as TranslationKey, field: "requestSendMs" as const },
  { color: PHASE_COLORS.wait, labelKey: "inspector.waterfall.wait" as TranslationKey, field: "waitingMs" as const },
  { color: PHASE_COLORS.download, labelKey: "inspector.waterfall.download" as TranslationKey, field: "responseReadMs" as const },
];

export function WaterfallChart({
  timing,
}: {
  timing: TimingBreakdown | undefined;
}) {
  const { t } = useI18n();

  const totalMs = timing?.totalMs;
  const hasTimingData = timing && (
    timing.dnsMs != null
    || timing.connectMs != null
    || timing.tlsMs != null
    || timing.requestSendMs != null
    || timing.waitingMs != null
    || timing.responseReadMs != null
  );

  if (!hasTimingData && (totalMs == null || totalMs === 0)) {
    return (
      <Typography
        color="text.disabled"
        sx={{
          fontSize: (theme) => {
            const scale = theme.typography.fontSize / 14;
            return `${scale * 12}px`;
          },
          fontStyle: "italic",
          lineHeight: 1.45,
          py: 0.5,
        }}
        variant="body2"
      >
        {t("inspector.waterfall.unavailable")}
      </Typography>
    );
  }

  const phases: WaterfallPhase[] = PHASE_KEYS.map((def) => ({
    color: def.color,
    labelKey: def.labelKey,
    valueMs: timing?.[def.field],
  }));

  const scale = resolveScale(phases, totalMs);

  return (
    <Stack spacing={0.5}>
      <Stack alignItems="center" direction="row" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <WaterfallBar phases={phases} scale={scale} />
        </Box>
        <Typography
          sx={{
            color: "text.secondary",
            flex: "0 0 auto",
            fontSize: (theme) => {
              const scale = theme.typography.fontSize / 14;
              return `${scale * 12}px`;
            },
            fontWeight: 500,
            lineHeight: 1,
            minWidth: 48,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
          variant="body2"
        >
          {totalMs != null ? `${totalMs} ms` : ""}
        </Typography>
      </Stack>
      <WaterfallLegend phases={phases} />
    </Stack>
  );
}

function WaterfallBar({
  phases,
  scale,
}: {
  phases: WaterfallPhase[];
  scale: number;
}) {
  return (
    <Box
      sx={{
        alignItems: "stretch",
        bgcolor: (theme) => theme.palette.mode === "dark"
          ? "rgba(255, 255, 255, 0.04)"
          : "rgba(0, 0, 0, 0.04)",
        borderRadius: 0.5,
        display: "flex",
        height: 24,
        overflow: "hidden",
        width: "100%",
      }}
    >
      {phases.map((phase) => {
        if (phase.valueMs == null) {
          return (
            <Box
              key={phase.labelKey}
              sx={{
                bgcolor: "rgba(128, 128, 128, 0.3)",
                width: GAP_MARKER_WIDTH,
              }}
            />
          );
        }

        const percentage = (phase.valueMs / scale) * 100;

        return (
          <Tooltip
            key={phase.labelKey}
            title={`${phase.valueMs} ms`}
            arrow
            enterDelay={200}
            placement="top"
          >
            <Box
              sx={{
                bgcolor: phase.color,
                minWidth: 2,
                width: `${percentage}%`,
                "&:hover": {
                  filter: "brightness(1.2)",
                },
                transition: "filter 120ms ease",
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

function WaterfallLegend({
  phases,
}: {
  phases: WaterfallPhase[];
}) {
  const { t } = useI18n();

  return (
    <Stack
      direction="row"
      spacing={1.25}
      sx={{
        flexWrap: "wrap",
        pt: 0.25,
      }}
    >
      {phases.map((phase) => (
        <Stack
          key={phase.labelKey}
          alignItems="center"
          direction="row"
          spacing={0.5}
        >
          <Box
            sx={{
              bgcolor: phase.color,
              borderRadius: 0.25,
              height: 8,
              width: 8,
            }}
          />
          <Typography
            color="text.secondary"
            sx={{
              fontSize: (theme) => {
                const scale = theme.typography.fontSize / 14;
                return `${scale * 10.5}px`;
              },
              lineHeight: 1.25,
            }}
          >
            {t(phase.labelKey)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function resolveScale(phases: WaterfallPhase[], totalMs: number | undefined): number {
  if (totalMs != null && totalMs > 0) {
    return totalMs;
  }

  let sum = 0;
  let hasValue = false;

  for (const phase of phases) {
    if (phase.valueMs != null) {
      sum += phase.valueMs;
      hasValue = true;
    }
  }

  return hasValue && sum > 0 ? sum : 1;
}
