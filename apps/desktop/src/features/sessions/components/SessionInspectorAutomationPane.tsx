import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DifferenceRoundedIcon from "@mui/icons-material/DifferenceRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useQuery } from "@tanstack/react-query";
import type { MapSessionTrace, RewriteSessionTrace, ScriptSessionTrace, ThrottleSessionTrace } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { listMapSessionTrace, listRewriteSessionTrace, listScriptSessionTrace, listThrottleSessionTrace } from "@/services/commands";
import { fontFamilies } from "@/themes/fonts";

function outcomeColor(outcome: string): "default" | "error" | "info" | "success" | "warning" {
  if (outcome === "success") return "success";
  if (outcome === "skipped") return "info";
  if (outcome === "failed" || outcome === "runtimeError" || outcome === "invalidResult" || outcome === "timedOut") return "error";
  return "default";
}

function RewriteTraceCard({ trace }: { trace: RewriteSessionTrace }) {
  const title = trace.ruleName || trace.ruleId;

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: "8px", overflow: "hidden" }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.055),
          borderBottom: 1,
          borderColor: "divider",
          px: 1.5,
          py: 1,
        })}
      >
        <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
          <RuleRoundedIcon sx={{ color: "primary.main", fontSize: 18 }} />
          <Box minWidth={0}>
            <Typography variant="body2" sx={{ fontWeight: 750 }} noWrap>{title}</Typography>
            <Typography color="text.secondary" variant="caption" noWrap>{trace.ruleId}</Typography>
          </Box>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip size="small" label={trace.rewriteType} />
          <Chip size="small" label={trace.stage} variant="outlined" />
          <Chip size="small" color={outcomeColor(trace.outcome)} label={trace.outcome} variant="outlined" />
          <Chip size="small" label={`${trace.durationMs} ms`} variant="outlined" />
        </Stack>
      </Stack>

      <Stack spacing={1} sx={{ p: 1.5 }}>
        {trace.entries.length === 0 ? (
          <Typography color="text.secondary" variant="body2">No recorded changes.</Typography>
        ) : trace.entries.map((entry) => (
          <Paper
            key={`${trace.ruleId}-${entry.sequence}`}
            elevation={0}
            sx={{
              bgcolor: "background.default",
              border: 1,
              borderColor: "divider",
              borderRadius: "8px",
              p: 1,
            }}
          >
            <Stack spacing={0.75}>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                <DifferenceRoundedIcon sx={{ color: "text.secondary", fontSize: 16 }} />
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{entry.kind}</Typography>
                {entry.key ? <Chip size="small" label={entry.key} sx={{ height: 20, fontSize: 11 }} /> : null}
                {entry.message ? <Typography color="text.secondary" variant="caption">{entry.message}</Typography> : null}
              </Stack>
              <Box
                sx={{
                  display: "grid",
                  gap: 1,
                  gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                }}
              >
                <DiffValue label="Before" value={entry.before} />
                <DiffValue label="After" value={entry.after} />
              </Box>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Paper>
  );
}

function DiffValue({ label, value }: { label: string; value: string | undefined }) {
  return (
    <Stack spacing={0.4}>
      <Typography color="text.secondary" variant="caption" sx={{ fontWeight: 700 }}>{label}</Typography>
      <Typography
        component="pre"
        sx={{
          bgcolor: "action.hover",
          borderRadius: "6px",
          fontFamily: fontFamilies.mono,
          fontSize: 12,
          m: 0,
          minHeight: 34,
          overflowX: "auto",
          p: 1,
          whiteSpace: "pre-wrap",
        }}
      >
        {value ?? "(empty)"}
      </Typography>
    </Stack>
  );
}

function ScriptTraceCard({ trace, index }: { index: number; trace: ScriptSessionTrace }) {
  return (
    <Paper key={`${trace.ruleId}-${trace.stage}-${index}`} elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: "8px", p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
            <CodeRoundedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
            <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
              {trace.ruleId}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" label={trace.stage} />
            <Chip size="small" color={outcomeColor(trace.outcome)} label={trace.outcome} variant="outlined" />
            <Chip size="small" label={`${trace.durationMs} ms`} variant="outlined" />
          </Stack>
        </Stack>

        {trace.entries.length > 0 && <Divider />}

        <Stack spacing={0.75}>
          {trace.entries.map((entry) => (
            <Stack key={`${trace.ruleId}-${trace.stage}-${entry.sequence}`} spacing={0.35}>
              <Typography variant="caption" color="text.secondary">
                {entry.kind}{entry.level ? ` - ${entry.level}` : ""}{entry.key ? ` - ${entry.key}` : ""}
              </Typography>
              {entry.message && (
                <Typography variant="body2">
                  {entry.message}
                </Typography>
              )}
              {entry.payloadJson && (
                <Typography
                  component="pre"
                  sx={{
                    borderRadius: "6px",
                    bgcolor: "action.hover",
                    fontFamily: fontFamilies.mono,
                    fontSize: 12,
                    m: 0,
                    overflowX: "auto",
                    p: 1,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {entry.payloadJson}
                </Typography>
              )}
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

function MapTraceCard({ trace }: { trace: MapSessionTrace }) {
  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: "8px", p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
            <AltRouteRoundedIcon sx={{ color: "primary.main", fontSize: 18 }} />
            <Box minWidth={0}>
              <Typography variant="body2" sx={{ fontWeight: 750 }} noWrap>{trace.ruleName || trace.ruleId}</Typography>
              <Typography color="text.secondary" variant="caption" noWrap>{trace.ruleId}</Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" label={trace.mode} />
            <Chip size="small" color={outcomeColor(trace.outcome)} label={trace.outcome} variant="outlined" />
            <Chip size="small" label={`${trace.durationMs} ms`} variant="outlined" />
          </Stack>
        </Stack>
        <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          <DiffValue label="Original" value={trace.originalUrl} />
          <DiffValue label={trace.mode === "local" ? "Local Path" : "Mapped URL"} value={trace.localPath ?? trace.mappedUrl} />
        </Box>
        <Typography color="text.secondary" variant="caption" noWrap>
          {`${trace.sourcePattern} -> ${trace.targetValue}`}
        </Typography>
      </Stack>
    </Paper>
  );
}

function ThrottleTraceCard({ trace }: { trace: ThrottleSessionTrace }) {
  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: "8px", p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={1} alignItems="center" minWidth={0}>
            <SpeedRoundedIcon sx={{ color: trace.outcome === "dropped" ? "error.main" : "primary.main", fontSize: 18 }} />
            <Box minWidth={0}>
              <Typography variant="body2" sx={{ fontWeight: 750 }} noWrap>{trace.ruleName ?? trace.profileName}</Typography>
              <Typography color="text.secondary" variant="caption" noWrap>{trace.profileName}</Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" label={trace.stage} />
            <Chip size="small" color={trace.outcome === "dropped" ? "error" : "success"} label={trace.outcome} variant="outlined" />
            <Chip size="small" label={`${trace.delayMs} ms`} variant="outlined" />
          </Stack>
        </Stack>
        <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", sm: "repeat(3, minmax(0, 1fr))" } }}>
          <Metric label="Latency" value={`${trace.latencyMs} ms`} />
          <Metric label="Transfer" value={`${trace.transferDelayMs} ms`} />
          <Metric label="Body" value={`${trace.bodyBytes} B`} />
        </Box>
        {trace.message ? <Typography color="text.secondary" variant="body2">{trace.message}</Typography> : null}
      </Stack>
    </Paper>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Stack spacing={0.25} sx={{ bgcolor: "action.hover", borderRadius: "6px", px: 1, py: 0.75 }}>
      <Typography color="text.secondary" variant="caption">{label}</Typography>
      <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 12.5, fontWeight: 700 }}>{value}</Typography>
    </Stack>
  );
}

export function SessionInspectorAutomationPane({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const rewriteQuery = useQuery({
    queryKey: ["rewrite-session-trace", sessionId],
    queryFn: () => listRewriteSessionTrace(sessionId),
    staleTime: 30_000,
  });
  const scriptQuery = useQuery({
    queryKey: ["script-session-trace", sessionId],
    queryFn: () => listScriptSessionTrace(sessionId),
    staleTime: 30_000,
  });
  const throttleQuery = useQuery({
    queryKey: ["throttle-session-trace", sessionId],
    queryFn: () => listThrottleSessionTrace(sessionId),
    staleTime: 30_000,
  });
  const mapQuery = useQuery({
    queryKey: ["map-session-trace", sessionId],
    queryFn: () => listMapSessionTrace(sessionId),
    staleTime: 30_000,
  });

  if (rewriteQuery.isLoading || scriptQuery.isLoading || throttleQuery.isLoading || mapQuery.isLoading) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 160 }}>
        <CircularProgress size={22} />
      </Stack>
    );
  }

  if (rewriteQuery.error || scriptQuery.error || throttleQuery.error || mapQuery.error) {
    return (
      <Alert severity="error" variant="outlined">
        {t("automationTab.loadFailed")}
      </Alert>
    );
  }

  const rewriteTraces = rewriteQuery.data ?? [];
  const scriptTraces = scriptQuery.data ?? [];
  const throttleTraces = throttleQuery.data ?? [];
  const mapTraces = mapQuery.data ?? [];

  if (rewriteTraces.length === 0 && scriptTraces.length === 0 && throttleTraces.length === 0 && mapTraces.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {t("automationTab.emptyDescription")}
      </Typography>
    );
  }

  return (
    <Stack spacing={2}>
      {throttleTraces.length > 0 ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <SpeedRoundedIcon sx={{ color: "primary.main", fontSize: 18 }} />
            <Typography variant="subtitle2">Throttling</Typography>
            <Chip size="small" label={throttleTraces.length} sx={{ height: 20 }} />
          </Stack>
          {throttleTraces.map((trace) => (
            <ThrottleTraceCard key={`${trace.profileId}-${trace.stage}-${trace.sequence}`} trace={trace} />
          ))}
        </Stack>
      ) : null}

      {mapTraces.length > 0 ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <AltRouteRoundedIcon sx={{ color: "primary.main", fontSize: 18 }} />
            <Typography variant="subtitle2">Map</Typography>
            <Chip size="small" label={mapTraces.length} sx={{ height: 20 }} />
          </Stack>
          {mapTraces.map((trace, index) => (
            <MapTraceCard key={`${trace.ruleId}-${trace.mode}-${index}`} trace={trace} />
          ))}
        </Stack>
      ) : null}

      {rewriteTraces.length > 0 ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <RuleRoundedIcon sx={{ color: "primary.main", fontSize: 18 }} />
            <Typography variant="subtitle2">Rewrite</Typography>
            <Chip size="small" label={rewriteTraces.length} sx={{ height: 20 }} />
          </Stack>
          {rewriteTraces.map((trace) => (
            <RewriteTraceCard key={`${trace.ruleId}-${trace.stage}-${trace.durationMs}-${trace.entries.length}`} trace={trace} />
          ))}
        </Stack>
      ) : null}

      {scriptTraces.length > 0 ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <CodeRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
            <Typography variant="subtitle2">Script</Typography>
            <Chip size="small" label={scriptTraces.length} sx={{ height: 20 }} />
          </Stack>
          {scriptTraces.map((trace, index) => (
            <ScriptTraceCard key={`${trace.ruleId}-${trace.stage}-${index}`} index={index} trace={trace} />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
