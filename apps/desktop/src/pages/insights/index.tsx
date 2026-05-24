import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  alpha,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import { useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { useI18n } from "@/i18n";
import { invokeGetInsights } from "@/services/commands/sessions";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1) {
    return "<1 ms";
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  return `${(ms / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function truncateUrl(url: string, maxLength: number = 60): string {
  if (url.length <= maxLength) {
    return url;
  }

  return url.slice(0, maxLength - 3) + "...";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverviewCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card
      elevation={0}
      variant="outlined"
      sx={(theme) => ({
        bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
        borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
        borderRadius: 1.25,
        flex: "1 1 0",
        minWidth: 120,
      })}
    >
      <CardContent sx={{ px: 2, py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Typography
          color="text.secondary"
          sx={{ fontSize: 12, fontWeight: 500, mb: 0.25 }}
        >
          {label}
        </Typography>
        <Typography
          sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}
        >
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography
      sx={{
        fontSize: 14,
        fontWeight: 600,
        mb: 1,
        mt: 0.5,
      }}
    >
      {children}
    </Typography>
  );
}

function DistributionItem({
  label,
  count,
  maxCount,
}: {
  label: string;
  count: number;
  maxCount: number;
}) {
  const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;

  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", py: 0.5 }}>
      <Typography
        sx={{
          fontSize: 13,
          fontWeight: 500,
          minWidth: 48,
          textAlign: "right",
          fontFamily: "monospace",
        }}
      >
        {label}
      </Typography>
      <Box
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.primary.main, 0.12),
          borderRadius: 0.5,
          flex: 1,
          height: 20,
          position: "relative",
          overflow: "hidden",
        })}
      >
        <Box
          sx={(theme) => ({
            bgcolor: alpha(theme.palette.primary.main, 0.45),
            borderRadius: 0.5,
            height: "100%",
            transition: "width 300ms ease",
            width: `${barWidth}%`,
          })}
        />
      </Box>
      <Typography
        sx={{
          fontSize: 13,
          minWidth: 48,
          color: "text.secondary",
          fontFamily: "monospace",
        }}
      >
        {formatNumber(count)}
      </Typography>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function InsightsPage() {
  const { t } = useI18n();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();

  const { data, isLoading } = useQuery({
    queryKey: ["insights"],
    queryFn: () => invokeGetInsights(),
  });

  const headerActions = useMemo(
    () => (
      <Stack direction="row" spacing={1.25}>
        <Box
          component="button"
          disabled
          sx={{
            alignItems: "center",
            bgcolor: "transparent",
            border: "1px solid",
            borderColor: "action.disabledBackground",
            borderRadius: 1,
            color: "action.disabled",
            cursor: "not-allowed",
            display: "inline-flex",
            fontFamily: "inherit",
            gap: 0.5,
            px: 1.25,
            py: 0.5,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <FileDownloadRoundedIcon sx={{ fontSize: 16 }} />
          {t("insightsPage.export.title")}
        </Box>
      </Stack>
    ),
    [t],
  );

  useLayoutEffect(() => {
    setHeaderActions(headerActions);

    return () => {
      setHeaderActions(null);
    };
  }, [headerActions, setHeaderActions]);

  if (isLoading) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        spacing={1.5}
        sx={{ height: "100%", minHeight: 240 }}
      >
        <CircularProgress size={24} />
        <Typography color="text.secondary" sx={{ fontSize: 13 }}>
          {t("insightsPage.states.loading")}
        </Typography>
      </Stack>
    );
  }

  if (!data || data.totalRequests === 0) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100%", minHeight: 240 }}
      >
        <Typography color="text.secondary" sx={{ fontSize: 13 }}>
          {t("insightsPage.states.noData")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <Paper
        elevation={0}
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
          border: "1px solid",
          borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
          borderRadius: 1.25,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 16px 44px rgba(0, 0, 0, 0.28)"
              : "0 16px 40px rgba(15, 23, 42, 0.08)",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          p: 2,
        })}
        variant="outlined"
      >
        {/* Overview cards */}
        <Stack direction="row" spacing={1.25} sx={{ flexWrap: "wrap", mb: 2.5 }}>
          <OverviewCard
            label={t("insightsPage.overview.totalRequests")}
            value={formatNumber(data.totalRequests)}
          />
          <OverviewCard
            label={t("insightsPage.overview.errorRate")}
            value={formatPercent(data.errorRate)}
          />
          <OverviewCard
            label={t("insightsPage.overview.avgDuration")}
            value={formatDuration(data.avgDurationMs)}
          />
          <OverviewCard
            label={t("insightsPage.overview.p95Duration")}
            value={formatDuration(data.p95DurationMs)}
          />
          <OverviewCard
            label={t("insightsPage.overview.totalTraffic")}
            value={formatBytes(data.totalBytes)}
          />
        </Stack>

        {/* By Host table */}
        {data.byHost.length > 0 && (
          <Box sx={{ mb: 2.5 }}>
            <SectionTitle>{t("insightsPage.hosts.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.host")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.requests")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.errors")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.avgDuration")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.p95Duration")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.hosts.traffic")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byHost.map((host) => (
                  <TableRow key={host.host}>
                    <TableCell sx={{ fontSize: 13, fontFamily: "monospace" }}>{host.host}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatNumber(host.requestCount)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatNumber(host.errorCount)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatDuration(host.avgDurationMs)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatDuration(host.p95DurationMs)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatBytes(host.totalBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}

        {/* Slow requests table */}
        {data.slowRequests.length > 0 && (
          <Box sx={{ mb: 2.5 }}>
            <SectionTitle>{t("insightsPage.slowRequests.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.slowRequests.url")}</TableCell>
                  <TableCell sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.slowRequests.method")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.slowRequests.status")}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: 12 }}>{t("insightsPage.slowRequests.duration")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.slowRequests.map((req) => (
                  <TableRow key={req.sessionId}>
                    <TableCell sx={{ fontSize: 13, fontFamily: "monospace" }} title={req.url}>
                      {truncateUrl(req.url)}
                    </TableCell>
                    <TableCell sx={{ fontSize: 13 }}>{req.method}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{req.statusCode}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>{formatDuration(req.durationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}

        {/* Status codes & Methods side by side */}
        <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap" }}>
          {data.byStatusCode.length > 0 && (
            <Box sx={{ flex: "1 1 280px", minWidth: 280 }}>
              <SectionTitle>{t("insightsPage.statusCodes.title")}</SectionTitle>
              <Stack spacing={0.25}>
                {data.byStatusCode
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((entry) => (
                    <DistributionItem
                      key={entry.statusCode}
                      label={String(entry.statusCode)}
                      count={entry.count}
                      maxCount={data.byStatusCode[0]?.count ?? 0}
                    />
                  ))}
              </Stack>
            </Box>
          )}

          {data.byMethod.length > 0 && (
            <Box sx={{ flex: "1 1 280px", minWidth: 280 }}>
              <SectionTitle>{t("insightsPage.methods.title")}</SectionTitle>
              <Stack spacing={0.25}>
                {data.byMethod
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((entry) => (
                    <DistributionItem
                      key={entry.method}
                      label={entry.method}
                      count={entry.count}
                      maxCount={data.byMethod[0]?.count ?? 0}
                    />
                  ))}
              </Stack>
            </Box>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
