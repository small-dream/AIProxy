import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  InputBase,
  inputBaseClasses,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  alpha,
  darken,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { downloadTextFile } from "@/lib/download";
import { useI18n, type TranslationKey } from "@/i18n";
import { useSessionContainerFilterStore } from "@/features/sessions/session-container.store";
import type { InsightsResult, SessionSummary } from "@aiproxy/shared-types";
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

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.round((percentileValue / 100) * (sortedValues.length - 1));
  return sortedValues[Math.min(index, sortedValues.length - 1)] ?? 0;
}

function summarizeUrl(url: string): { host: string; primary: string; secondary: string } {
  try {
    const parsed = new URL(url);
    const methodName = parsed.searchParams.get("_method") ?? parsed.searchParams.get("method");
    const secondaryParts = Array.from(parsed.searchParams.entries())
      .filter(([key]) => key !== "_method" && key !== "method")
      .slice(0, 2)
      .map(([key, value]) => `${key}=${value}`);

    return {
      host: parsed.host,
      primary: methodName ? `${parsed.pathname} · ${methodName}` : parsed.pathname,
      secondary: secondaryParts.length > 0 ? secondaryParts.join("  ") : parsed.search,
    };
  } catch {
    return {
      host: "",
      primary: url,
      secondary: "",
    };
  }
}

function getDurationIntensity(durationMs: number, maxDurationMs: number): number {
  if (maxDurationMs <= 0) {
    return 0;
  }

  return Math.min(1, durationMs / maxDurationMs);
}

function computeInsightsFromSummaries(
  summaries: SessionSummary[],
  hostKeyword: string,
): InsightsResult {
  const normalizedKeyword = hostKeyword.trim().toLowerCase();
  const filteredSummaries = normalizedKeyword
    ? summaries.filter((summary) => summary.host.toLowerCase().includes(normalizedKeyword))
    : summaries;
  const totalRequests = filteredSummaries.length;
  const totalErrors = filteredSummaries.filter((summary) => summary.statusCode >= 400).length;
  const totalBytes = filteredSummaries.reduce((sum, summary) => sum + summary.sizeBytes, 0);
  const sortedDurations = filteredSummaries
    .map((summary) => summary.durationMs)
    .sort((a, b) => a - b);

  const hostBuckets = new Map<string, SessionSummary[]>();
  const statusCodeCounts = new Map<number, number>();
  const methodCounts = new Map<string, number>();

  for (const summary of filteredSummaries) {
    hostBuckets.set(summary.host, [...(hostBuckets.get(summary.host) ?? []), summary]);
    statusCodeCounts.set(summary.statusCode, (statusCodeCounts.get(summary.statusCode) ?? 0) + 1);
    methodCounts.set(summary.method, (methodCounts.get(summary.method) ?? 0) + 1);
  }

  return {
    totalRequests,
    totalErrors,
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    avgDurationMs: totalRequests > 0
      ? filteredSummaries.reduce((sum, summary) => sum + summary.durationMs, 0) / totalRequests
      : 0,
    p50DurationMs: percentile(sortedDurations, 50),
    p95DurationMs: percentile(sortedDurations, 95),
    p99DurationMs: percentile(sortedDurations, 99),
    totalBytes,
    byHost: Array.from(hostBuckets.entries())
      .map(([host, hostSummaries]) => {
        const hostDurations = hostSummaries.map((summary) => summary.durationMs).sort((a, b) => a - b);
        const requestCount = hostSummaries.length;
        return {
          host,
          requestCount,
          errorCount: hostSummaries.filter((summary) => summary.statusCode >= 400).length,
          avgDurationMs: requestCount > 0
            ? hostSummaries.reduce((sum, summary) => sum + summary.durationMs, 0) / requestCount
            : 0,
          p95DurationMs: percentile(hostDurations, 95),
          totalBytes: hostSummaries.reduce((sum, summary) => sum + summary.sizeBytes, 0),
        };
      })
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 50),
    byStatusCode: Array.from(statusCodeCounts.entries())
      .map(([statusCode, count]) => ({ statusCode, count }))
      .sort((a, b) => b.count - a.count),
    byMethod: Array.from(methodCounts.entries())
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count),
    slowRequests: filteredSummaries
      .slice()
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20)
      .map((summary) => ({
        sessionId: summary.id,
        url: summary.url,
        method: summary.method,
        statusCode: summary.statusCode,
        durationMs: summary.durationMs,
      })),
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverviewCard({
  label,
  tone = "primary",
  value,
}: {
  label: string;
  tone?: "error" | "primary" | "success" | "warning";
  value: string;
}) {
  return (
    <Card
      elevation={0}
      variant="outlined"
      sx={(theme) => ({
        bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
        borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
        borderLeftColor: theme.palette[tone].main,
        borderLeftWidth: 3,
        borderRadius: 1.25,
        flex: "1 1 0",
        minWidth: 120,
      })}
    >
      <CardContent sx={{ px: 2, py: 1.35, "&:last-child": { pb: 1.35 } }}>
        <Typography
          color="text.secondary"
          sx={{ fontSize: 12, fontWeight: 600, mb: 0.25 }}
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
        mb: 0.75,
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

  const activeSessionIds = useSessionContainerFilterStore((s) => s.activeSessionIds);
  const activeSessionSummaries = useSessionContainerFilterStore((s) => s.activeSessionSummaries);
  const [domainFilter, setDomainFilter] = useState("");
  const [debouncedDomain, setDebouncedDomain] = useState("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDomainChange = useCallback((value: string) => {
    setDomainFilter(value);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedDomain(value);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const input = useMemo(() => {
    const base = { sessionIds: activeSessionIds };
    return debouncedDomain ? { ...base, hostKeyword: debouncedDomain } : base;
  }, [activeSessionIds, debouncedDomain]);

  const { data: backendData, isLoading } = useQuery({
    queryKey: ["insights", activeSessionIds, debouncedDomain],
    queryFn: () => invokeGetInsights(input),
  });
  const fallbackData = useMemo(
    () => computeInsightsFromSummaries(activeSessionSummaries, debouncedDomain),
    [activeSessionSummaries, debouncedDomain],
  );
  const data = backendData && backendData.totalRequests > 0
    ? backendData
    : fallbackData.totalRequests > 0
      ? fallbackData
      : backendData;
  const slowRequestMaxDuration = data?.slowRequests.reduce(
    (maxDuration, req) => Math.max(maxDuration, req.durationMs),
    0,
  ) ?? 0;

  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const [exportAnchorEl, setExportAnchorEl] = useState<HTMLElement | null>(null);

  const handleExport = useCallback(
    (format: "markdown" | "json") => {
      if (!data) return;
      const timestamp = new Date().toISOString().slice(0, 10);

      if (format === "json") {
        const json = JSON.stringify(data, null, 2);
        downloadTextFile(`insights-${timestamp}.json`, json, "application/json");
      } else {
        const md = buildMarkdownReport(data, t);
        downloadTextFile(`insights-${timestamp}.md`, md, "text/markdown");
      }

      setExportAnchorEl(null);
    },
    [data, t],
  );

  const headerActions = useMemo(
    () => (
      <>
        <TopBarActionButton
          disabled={!data}
          icon={<FileDownloadRoundedIcon />}
          label={t("insightsPage.export.title")}
          onClick={() => setExportAnchorEl(exportButtonRef.current)}
          buttonRef={exportButtonRef}
        />
        <Menu
          anchorEl={exportAnchorEl}
          open={Boolean(exportAnchorEl)}
          onClose={() => setExportAnchorEl(null)}
        >
          <MenuItem onClick={() => handleExport("markdown")}>
            {t("insightsPage.export.markdown")}
          </MenuItem>
          <MenuItem onClick={() => handleExport("json")}>
            {t("insightsPage.export.json")}
          </MenuItem>
        </Menu>
      </>
    ),
    [t, data, exportAnchorEl, handleExport],
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
    <Stack spacing={0.75} sx={{ height: "100%", minHeight: 0 }}>
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 1,
          justifyContent: "space-between",
          mb: 0.25,
        }}
      >
        <InputBase
          startAdornment={
            <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 18, mr: 0.75 }} />
          }
          placeholder={t("insightsPage.filter.domainPlaceholder")}
          value={domainFilter}
          onChange={(e) => handleDomainChange(e.target.value)}
          sx={(theme) => ({
            bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
            border: "1px solid",
            borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
            borderRadius: 1,
            px: 1.25,
            py: 0.5,
            fontSize: 13,
            flex: 1,
            maxWidth: 320,
            [`& .${inputBaseClasses.input}`]: {
              p: 0,
            },
          })}
        />
        <Typography
          color="text.secondary"
          sx={{
            flex: "0 0 auto",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {t("insightsPage.scope.current", { count: formatNumber(data.totalRequests) })}
        </Typography>
      </Stack>
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
          p: 1.75,
        })}
        variant="outlined"
      >
        {/* Overview cards */}
        <Stack direction="row" spacing={1.1} sx={{ flexWrap: "wrap", mb: 2.25 }}>
          <OverviewCard
            label={t("insightsPage.overview.totalRequests")}
            tone="primary"
            value={formatNumber(data.totalRequests)}
          />
          <OverviewCard
            label={t("insightsPage.overview.errorRate")}
            tone={data.errorRate > 0 ? "error" : "success"}
            value={formatPercent(data.errorRate)}
          />
          <OverviewCard
            label={t("insightsPage.overview.avgDuration")}
            tone={data.avgDurationMs >= 1000 ? "warning" : "success"}
            value={formatDuration(data.avgDurationMs)}
          />
          <OverviewCard
            label={t("insightsPage.overview.p95Duration")}
            tone={data.p95DurationMs >= 1000 ? "warning" : "success"}
            value={formatDuration(data.p95DurationMs)}
          />
          <OverviewCard
            label={t("insightsPage.overview.totalTraffic")}
            tone="primary"
            value={formatBytes(data.totalBytes)}
          />
        </Stack>

        {data.byHost.length > 0 && (
          <Box sx={{ mb: 2.25 }}>
            <SectionTitle>{t("insightsPage.hosts.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.host")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.requests")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.errors")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.avgDuration")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.p95Duration")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.hosts.traffic")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byHost.map((host) => (
                  <TableRow
                    hover
                    key={host.host}
                    sx={{ "&:last-child td": { borderBottom: 0 } }}
                  >
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

        <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", mb: 2.25 }}>
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

        {data.slowRequests.length > 0 && (
          <Box>
            <SectionTitle>{t("insightsPage.slowRequests.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.slowRequests.url")}</TableCell>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.slowRequests.method")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.slowRequests.status")}</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>{t("insightsPage.slowRequests.duration")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.slowRequests.map((req) => {
                  const urlSummary = summarizeUrl(req.url);
                  const durationIntensity = getDurationIntensity(req.durationMs, slowRequestMaxDuration);

                  return (
                    <TableRow
                      hover
                      key={req.sessionId}
                      sx={{ "&:last-child td": { borderBottom: 0 } }}
                    >
                      <TableCell sx={{ minWidth: 360 }} title={req.url}>
                        <Typography
                          sx={{
                            fontFamily: "monospace",
                            fontSize: 13,
                            fontWeight: 600,
                            lineHeight: 1.35,
                          }}
                        >
                          {urlSummary.primary}
                        </Typography>
                        <Typography
                          color="text.secondary"
                          noWrap
                          sx={{
                            fontFamily: "monospace",
                            fontSize: 12,
                            maxWidth: 820,
                          }}
                        >
                          {[urlSummary.host, urlSummary.secondary].filter(Boolean).join("  ")}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontSize: 13, fontWeight: 600 }}>{req.method}</TableCell>
                      <TableCell
                        align="right"
                        sx={(theme) => ({
                          color: req.statusCode >= 400 ? theme.palette.error.main : theme.palette.success.main,
                          fontSize: 13,
                          fontWeight: 700,
                        })}
                      >
                        {req.statusCode}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={(theme) => ({
                          bgcolor: alpha(theme.palette.warning.main, 0.08 + durationIntensity * 0.16),
                          borderRadius: 0.5,
                          color: durationIntensity > 0.85
                            ? darken(theme.palette.warning.main, theme.palette.mode === "dark" ? 0 : 0.25)
                            : "text.primary",
                          fontSize: 13,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        })}
                      >
                        {formatDuration(req.durationMs)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Markdown report builder
// ---------------------------------------------------------------------------

function buildMarkdownReport(
  data: InsightsResult,
  t: (key: TranslationKey) => string,
): string {
  const lines: string[] = [
    `# ${t("insightsPage.title")}`,
    "",
    `## ${t("insightsPage.hosts.title")}`,
    "",
    `| Host | Requests | Errors | Avg | P95 | Traffic |`,
    `|------|----------|--------|-----|-----|---------|`,
  ];

  for (const host of data.byHost.slice(0, 20)) {
    lines.push(
      `| ${host.host} | ${host.requestCount} | ${host.errorCount} | ${formatDuration(host.avgDurationMs)} | ${formatDuration(host.p95DurationMs)} | ${formatBytes(host.totalBytes)} |`,
    );
  }

  lines.push("");
  lines.push(`## ${t("insightsPage.slowRequests.title")}`);
  lines.push("");
  lines.push(`| URL | Method | Status | Duration |`);
  lines.push(`|-----|--------|--------|----------|`);

  for (const req of data.slowRequests) {
    lines.push(
      `| ${req.url} | ${req.method} | ${req.statusCode} | ${formatDuration(req.durationMs)} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
