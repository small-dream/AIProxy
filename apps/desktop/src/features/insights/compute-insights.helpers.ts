import type { InsightsResult, SessionSummary, SlowRequest } from "@aiproxy/shared-types";

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
  largestRequests: [],
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

/**
 * Order-sensitive equality check for session-id snapshots. Used to detect when
 * the live `activeSessionIds` has diverged from its 5s-debounced backend
 * snapshot — including the same-length-different-content case (e.g. switching
 * to another session container with the same number of sessions), which a
 * length-only check would miss.
 */
export function areSessionIdsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
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

export function getIntensity(value: number, maxValue: number): number {
  if (maxValue <= 0) {
    return 0;
  }

  return Math.min(1, value / maxValue);
}

// ---------------------------------------------------------------------------
// Comparison helpers (deterministic tiebreakers)
// ---------------------------------------------------------------------------
//
// Every ranking sorts on a single primary key (duration / size / count), so
// rows that tie on it have no defined order. The backend `ORDER BY` and this
// frontend sort must agree on the tiebreaker, otherwise tied rows reorder every
// time the view flips between the persisted backend result and the live
// frontend computation (see use-insights-data.tsx). These helpers encode the
// shared rule: newest-first by `startedAt`, then `id` ASC, for the request
// lists; the natural key ASC for the distributions.

// ISO 8601 UTC `startedAt` values sort chronologically under lexicographic
// comparison, so plain `<` / `>` stays in lockstep with the backend
// `ORDER BY ... started_at DESC`.
function compareStartedAtDesc(a: { startedAt: string }, b: { startedAt: string }): number {
  if (a.startedAt > b.startedAt) {
    return -1;
  }
  if (a.startedAt < b.startedAt) {
    return 1;
  }
  return 0;
}

function compareStringAsc(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function compareNumberAsc(a: number, b: number): number {
  return a - b;
}

function toSlowRequest(summary: SessionSummary): SlowRequest {
  return {
    sessionId: summary.id,
    url: summary.url,
    method: summary.method,
    statusCode: summary.statusCode,
    durationMs: summary.durationMs,
    sizeBytes: summary.sizeBytes,
  };
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
  // When the view is scoped to a host (focused debugging), show every matching
  // request instead of the top-20 overview cap.
  const isHostScoped = Boolean(filters.hostExact?.trim()) || filters.hostKeyword.trim().length > 0;
  const rankingLimit = isHostScoped ? Number.POSITIVE_INFINITY : 20;
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
    // statusCode 0 means the request is still in flight (no response yet); it is
    // not a real HTTP status code, so it is excluded from the distribution.
    if (summary.statusCode > 0) {
      statusCodeCounts.set(summary.statusCode, (statusCodeCounts.get(summary.statusCode) ?? 0) + 1);
    }
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
      .sort((a, b) => b.requestCount - a.requestCount || compareStringAsc(a.host, b.host))
      .slice(0, 50),
    byStatusCode: Array.from(statusCodeCounts.entries())
      .map(([statusCode, count]) => ({ statusCode, count }))
      .sort((a, b) => b.count - a.count || compareNumberAsc(a.statusCode, b.statusCode)),
    byMethod: Array.from(methodCounts.entries())
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count || compareStringAsc(a.method, b.method)),
    slowRequests: filteredSummaries
      .slice()
      .sort(
        (a, b) =>
          b.durationMs - a.durationMs || compareStartedAtDesc(a, b) || compareStringAsc(a.id, b.id),
      )
      .slice(0, rankingLimit)
      .map(toSlowRequest),
    largestRequests: filteredSummaries
      .slice()
      .sort(
        (a, b) =>
          b.sizeBytes - a.sizeBytes || compareStartedAtDesc(a, b) || compareStringAsc(a.id, b.id),
      )
      .slice(0, rankingLimit)
      .map(toSlowRequest),
  };
}
