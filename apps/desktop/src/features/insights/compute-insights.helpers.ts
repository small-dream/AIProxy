import type { InsightsResult, SessionSummary } from "@aiproxy/shared-types";
import type { TranslationKey } from "@/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsightsComputationFilters = {
  excludedHosts: string[];
  hostExact: string | null;
  hostKeyword: string;
};

export const EMPTY_INSIGHTS_RESULT: InsightsResult = {
  totalRequests: 0,
  totalErrors: 0,
  errorRate: 0,
  avgDurationMs: 0,
  p50DurationMs: 0,
  p95DurationMs: 0,
  p99DurationMs: 0,
  totalBytes: 0,
  byHost: [],
  byStatusCode: [],
  byMethod: [],
  slowRequests: [],
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1) {
    return "<1 ms";
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatBytes(bytes: number): string {
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

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function normalizeHostValue(host: string): string {
  return host.trim().toLowerCase();
}

export function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.round((percentileValue / 100) * (sortedValues.length - 1));
  return sortedValues[Math.min(index, sortedValues.length - 1)] ?? 0;
}

export function summarizeUrl(url: string): { host: string; primary: string; secondary: string } {
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

export function getDurationIntensity(durationMs: number, maxDurationMs: number): number {
  if (maxDurationMs <= 0) {
    return 0;
  }

  return Math.min(1, durationMs / maxDurationMs);
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export function computeInsightsFromSummaries(
  summaries: SessionSummary[],
  filters: InsightsComputationFilters,
): InsightsResult {
  const normalizedKeyword = normalizeHostValue(filters.hostKeyword);
  const normalizedExactHost = filters.hostExact ? normalizeHostValue(filters.hostExact) : "";
  const excludedHostSet = new Set(filters.excludedHosts.map(normalizeHostValue).filter(Boolean));
  const filteredSummaries = summaries.filter((summary) => {
    const normalizedHost = normalizeHostValue(summary.host);

    return (
      (!normalizedKeyword || normalizedHost.includes(normalizedKeyword)) &&
      (!normalizedExactHost || normalizedHost === normalizedExactHost) &&
      !excludedHostSet.has(normalizedHost)
    );
  });

  if (filteredSummaries.length === 0) {
    return EMPTY_INSIGHTS_RESULT;
  }

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
    avgDurationMs:
      totalRequests > 0
        ? filteredSummaries.reduce((sum, summary) => sum + summary.durationMs, 0) / totalRequests
        : 0,
    p50DurationMs: percentile(sortedDurations, 50),
    p95DurationMs: percentile(sortedDurations, 95),
    p99DurationMs: percentile(sortedDurations, 99),
    totalBytes,
    byHost: Array.from(hostBuckets.entries())
      .map(([host, hostSummaries]) => {
        const hostDurations = hostSummaries
          .map((summary) => summary.durationMs)
          .sort((a, b) => a - b);
        const requestCount = hostSummaries.length;
        return {
          host,
          requestCount,
          errorCount: hostSummaries.filter((summary) => summary.statusCode >= 400).length,
          avgDurationMs:
            requestCount > 0
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
// Markdown report builder
// ---------------------------------------------------------------------------

export function buildMarkdownReport(data: InsightsResult, t: (key: TranslationKey) => string): string {
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
