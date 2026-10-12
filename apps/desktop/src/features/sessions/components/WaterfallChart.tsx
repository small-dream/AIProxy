import { Box, Tooltip, Typography, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import type { TimingBreakdown } from "@aiproxy/shared-types";

import { useI18n, type TranslationKey } from "@/i18n";
import { formatTiming } from "./session-inspector.helpers";

export type TimingPhaseId = "dns" | "connect" | "tls" | "send" | "wait" | "download";

type TimingPhaseDefinition = {
  field: keyof TimingBreakdown;
  id: TimingPhaseId;
  labelKey: TranslationKey;
};

export type TimingSegment = {
  color: string;
  id: TimingPhaseId;
  labelKey: TranslationKey;
  percent: number;
  valueMs: number;
};

type PaletteMode = Theme["palette"]["mode"];

const BAR_HEIGHT = 10;
const SWATCH_SIZE = 8;
const DIM_OPACITY = 0.3;

// Muted chart palette: the phases stay distinguishable inside a thin strip
// without competing with the neutral key/value rows around them.
const PHASE_COLORS: Record<TimingPhaseId, Record<PaletteMode, string>> = {
  connect: { dark: "#dfae7c", light: "#c9925c" },
  dns: { dark: "#7fb3d0", light: "#6a9fbf" },
  download: { dark: "#a29ed0", light: "#8a86b8" },
  send: { dark: "#a8afb6", light: "#98a0a8" },
  tls: { dark: "#93bd93", light: "#7ba97b" },
  wait: { dark: "#d98a5a", light: "#c1662f" },
};

// Phase labels reuse the overview field labels so the strip and the rows below
// it never describe the same phase with two different words.
const TIMING_PHASES: readonly TimingPhaseDefinition[] = [
  { field: "dnsMs", id: "dns", labelKey: "inspector.request.overview.fields.dns" },
  { field: "connectMs", id: "connect", labelKey: "inspector.request.overview.fields.connect" },
  { field: "tlsMs", id: "tls", labelKey: "inspector.request.overview.fields.tlsHandshake" },
  { field: "requestSendMs", id: "send", labelKey: "inspector.request.overview.fields.request" },
  { field: "waitingMs", id: "wait", labelKey: "inspector.request.overview.fields.latency" },
  {
    field: "responseReadMs",
    id: "download",
    labelKey: "inspector.request.overview.fields.response",
  },
];

export function getTimingPhaseColor(phase: TimingPhaseId, mode: PaletteMode): string {
  return PHASE_COLORS[phase][mode];
}

/**
 * Builds the timing strip segments. Unmeasured phases are dropped instead of
 * being drawn as placeholders, so the strip never shows unexplained slivers.
 */
export function buildTimingSegments({
  mode,
  timing,
}: {
  mode: PaletteMode;
  timing: TimingBreakdown | undefined;
}): TimingSegment[] {
  const measured = TIMING_PHASES.flatMap((definition) => {
    const valueMs = timing?.[definition.field];

    return valueMs == null ? [] : [{ ...definition, valueMs }];
  });
  const scale = resolveScale(
    measured.map((phase) => phase.valueMs),
    timing?.totalMs,
  );

  return measured.map((phase) => ({
    color: getTimingPhaseColor(phase.id, mode),
    id: phase.id,
    labelKey: phase.labelKey,
    percent: (phase.valueMs / scale) * 100,
    valueMs: phase.valueMs,
  }));
}

export function TimingPhaseSwatch({ phase }: { phase: TimingPhaseId }) {
  const theme = useTheme();

  return (
    <Box
      aria-hidden
      sx={{
        bgcolor: getTimingPhaseColor(phase, theme.palette.mode),
        borderRadius: "50%",
        flex: "0 0 auto",
        height: SWATCH_SIZE,
        width: SWATCH_SIZE,
      }}
    />
  );
}

/** Keeps labels aligned in lists where only some rows carry a phase swatch. */
export function TimingPhaseSwatchSlot() {
  return <Box aria-hidden sx={{ flex: "0 0 auto", height: SWATCH_SIZE, width: SWATCH_SIZE }} />;
}

export function WaterfallChart({
  activePhase,
  timing,
}: {
  activePhase?: TimingPhaseId | undefined;
  timing: TimingBreakdown | undefined;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const segments = buildTimingSegments({ mode: theme.palette.mode, timing });

  if (segments.length === 0 && (timing?.totalMs == null || timing.totalMs === 0)) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: "text.disabled",

          fontSize: (theme) => {
            const scale = theme.typography.fontSize / 14;
            return `${scale * 12}px`;
          },

          fontStyle: "italic",
          lineHeight: 1.45,
          py: 0.5,
        }}
      >
        {t("inspector.waterfall.unavailable")}
      </Typography>
    );
  }

  return (
    <Box
      data-timing-bar=""
      sx={{
        alignItems: "stretch",
        bgcolor: "action.hover",
        borderRadius: 0.25,
        display: "flex",
        height: BAR_HEIGHT,
        overflow: "hidden",
        width: "100%",
      }}
    >
      {segments.length === 0 ? (
        <Box sx={{ bgcolor: "action.disabledBackground", width: "100%" }} />
      ) : (
        segments.map((segment) => (
          <Tooltip
            arrow
            enterDelay={200}
            key={segment.id}
            placement="top"
            title={`${t(segment.labelKey)} · ${formatTiming(segment.valueMs)} · ${Math.round(
              segment.percent,
            )}%`}
          >
            <Box
              data-timing-phase={segment.id}
              sx={{
                bgcolor: segment.color,
                minWidth: 2,
                opacity: activePhase == null || activePhase === segment.id ? 1 : DIM_OPACITY,
                transition: "opacity 120ms ease",
                width: `${segment.percent}%`,
              }}
            />
          </Tooltip>
        ))
      )}
    </Box>
  );
}

function resolveScale(values: number[], totalMs: number | undefined): number {
  if (totalMs != null && totalMs > 0) {
    return totalMs;
  }

  const sum = values.reduce((total, value) => total + value, 0);

  return sum > 0 ? sum : 1;
}
