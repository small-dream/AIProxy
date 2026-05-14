import type {
  SessionCompareEndpointRow,
  SessionCompareOverview,
  SessionComparePayload,
  SessionSummary,
} from "@aiproxy/shared-types";

export type SessionCompareScopeInput = {
  id: string;
  label: string;
  sessions: SessionSummary[];
};

const ENDPOINT_QUERY_KEYS = ["_method", "method", "action", "operation", "op", "event", "name"];
const MAX_SEQUENCE_ENTRIES = 120;
const MAX_SEQUENCE_MISMATCHES = 80;

export function buildSessionComparePayload(
  leftScope: SessionCompareScopeInput,
  rightScope: SessionCompareScopeInput,
  domainFilter: string[],
): SessionComparePayload {
  const normalizedDomainFilter = normalizeDomainFilter(domainFilter);
  const leftSessions = filterAndSortSessions(leftScope.sessions, normalizedDomainFilter);
  const rightSessions = filterAndSortSessions(rightScope.sessions, normalizedDomainFilter);

  return {
    compareMode: "session",
    left: buildScopeIdentity(leftScope, leftSessions),
    right: buildScopeIdentity(rightScope, rightSessions),
    domainFilter: normalizedDomainFilter,
    generatedAt: new Date().toISOString(),
    redacted: true,
    bodyIncluded: false,
    overview: {
      left: buildOverview(leftSessions),
      right: buildOverview(rightSessions),
    },
    domains: buildDomainRows(leftSessions, rightSessions),
    endpoints: buildEndpointRows(leftSessions, rightSessions),
    timeline: buildTimeline(leftSessions, rightSessions),
    sequence: buildSequence(leftSessions, rightSessions),
  };
}

export function normalizeEndpoint(session: SessionSummary): string {
  const url = parseUrl(session.url);
  const host = normalizeHost(url?.host ?? session.host);
  const path = normalizePath(url?.pathname ?? session.path);
  const keyParam = ENDPOINT_QUERY_KEYS
    .map((key) => [key, url?.searchParams.get(key)] as const)
    .find(([, value]) => Boolean(value?.trim()));
  const queryMarker = keyParam ? ` ${keyParam[0]}=${keyParam[1]}` : "";

  return `${session.method.toUpperCase()} ${host}${path}${queryMarker}`;
}

export function getAvailableDomains(leftSessions: SessionSummary[], rightSessions: SessionSummary[]) {
  return Array.from(new Set([...leftSessions, ...rightSessions].map((session) => normalizeHost(session.host))))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function filterAndSortSessions(sessions: SessionSummary[], domainFilter: string[]) {
  const domainSet = new Set(domainFilter.map(normalizeHost));
  return sessions
    .filter((session) => domainSet.size === 0 || domainSet.has(normalizeHost(session.host)))
    .slice()
    .sort((left, right) => compareIso(left.startedAt, right.startedAt));
}

function buildScopeIdentity(scope: SessionCompareScopeInput, sessions: SessionSummary[]) {
  return {
    id: scope.id,
    label: scope.label,
    requestCount: sessions.length,
    ...(sessions[0]?.startedAt ? { startedAt: sessions[0].startedAt } : {}),
    ...(sessions.at(-1)?.finishedAt ? { finishedAt: sessions.at(-1)!.finishedAt } : {}),
  };
}

function buildOverview(sessions: SessionSummary[]): SessionCompareOverview {
  const durations = sessions.map((session) => finiteNumber(session.durationMs));
  const totalDuration = sum(durations);
  const statusCodes = countStatusCodes(sessions);

  return {
    requestCount: sessions.length,
    successCount: sessions.filter((session) => session.statusCode >= 200 && session.statusCode < 400).length,
    failureCount: sessions.filter((session) => session.statusCode >= 400 || session.statusCode <= 0).length,
    domainCount: new Set(sessions.map((session) => normalizeHost(session.host))).size,
    totalSizeBytes: sum(sessions.map((session) => finiteNumber(session.sizeBytes))),
    statusCodes,
    durationMs: {
      min: durations.length > 0 ? Math.min(...durations) : 0,
      max: durations.length > 0 ? Math.max(...durations) : 0,
      average: durations.length > 0 ? Math.round(totalDuration / durations.length) : 0,
      total: totalDuration,
    },
  };
}

function buildDomainRows(leftSessions: SessionSummary[], rightSessions: SessionSummary[]) {
  const leftCounts = countBy(leftSessions, (session) => normalizeHost(session.host));
  const rightCounts = countBy(rightSessions, (session) => normalizeHost(session.host));
  const domains = Array.from(new Set([...leftCounts.keys(), ...rightCounts.keys()])).sort();

  return domains.map((domain) => {
    const leftCount = leftCounts.get(domain) ?? 0;
    const rightCount = rightCounts.get(domain) ?? 0;

    return {
      domain,
      leftCount,
      rightCount,
      delta: rightCount - leftCount,
      leftShare: percentage(leftCount, leftSessions.length),
      rightShare: percentage(rightCount, rightSessions.length),
    };
  });
}

function buildEndpointRows(leftSessions: SessionSummary[], rightSessions: SessionSummary[]): SessionCompareEndpointRow[] {
  const leftStats = collectEndpointStats(leftSessions);
  const rightStats = collectEndpointStats(rightSessions);
  const endpoints = Array.from(new Set([...leftStats.keys(), ...rightStats.keys()])).sort();

  return endpoints.map((endpoint) => {
    const left = leftStats.get(endpoint);
    const right = rightStats.get(endpoint);
    const leftCount = left?.count ?? 0;
    const rightCount = right?.count ?? 0;

    return {
      endpoint,
      kind: getEndpointKind(leftCount, rightCount),
      leftCount,
      rightCount,
      delta: rightCount - leftCount,
      leftAverageDurationMs: leftCount > 0 ? Math.round((left?.totalDurationMs ?? 0) / leftCount) : 0,
      rightAverageDurationMs: rightCount > 0 ? Math.round((right?.totalDurationMs ?? 0) / rightCount) : 0,
      leftTotalDurationMs: left?.totalDurationMs ?? 0,
      rightTotalDurationMs: right?.totalDurationMs ?? 0,
      leftStatusCodes: left?.statusCodes ?? {},
      rightStatusCodes: right?.statusCodes ?? {},
    };
  }).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.endpoint.localeCompare(right.endpoint));
}

function buildTimeline(leftSessions: SessionSummary[], rightSessions: SessionSummary[]) {
  const allSessions = [...leftSessions, ...rightSessions];
  if (allSessions.length === 0) {
    return { bucketMs: 1_000, buckets: [] };
  }

  const startMs = Math.min(...allSessions.map((session) => dateMs(session.startedAt)));
  const endMs = Math.max(...allSessions.map((session) => dateMs(session.startedAt)));
  const bucketMs = Math.max(1_000, Math.ceil(Math.max(1, endMs - startMs) / 12));
  const bucketCount = Math.min(48, Math.max(1, Math.floor((endMs - startMs) / bucketMs) + 1));
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * bucketMs;
    return {
      label: new Date(bucketStart).toISOString(),
      startedAt: new Date(bucketStart).toISOString(),
      leftCount: countSessionsInBucket(leftSessions, bucketStart, bucketMs),
      rightCount: countSessionsInBucket(rightSessions, bucketStart, bucketMs),
      delta: 0,
    };
  });

  return {
    bucketMs,
    buckets: buckets.map((bucket) => ({
      ...bucket,
      delta: bucket.rightCount - bucket.leftCount,
    })),
  };
}

function buildSequence(leftSessions: SessionSummary[], rightSessions: SessionSummary[]) {
  const left = leftSessions.map(normalizeEndpoint);
  const right = rightSessions.map(normalizeEndpoint);
  const leftCounts = countByValue(left);
  const rightCounts = countByValue(right);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const length = Math.max(left.length, right.length);
  const changedPositions = Array.from({ length }, (_, index) => {
    const leftEndpoint = left[index];
    const rightEndpoint = right[index];
    if (leftEndpoint === rightEndpoint) {
      return undefined;
    }
    return {
      index,
      ...(leftEndpoint ? { left: leftEndpoint } : {}),
      ...(rightEndpoint ? { right: rightEndpoint } : {}),
    };
  }).filter((entry): entry is { index: number; left?: string; right?: string } => Boolean(entry));

  return {
    left: left.slice(0, MAX_SEQUENCE_ENTRIES),
    right: right.slice(0, MAX_SEQUENCE_ENTRIES),
    addedEndpoints: Array.from(rightSet).filter((endpoint) => !leftSet.has(endpoint)).sort(),
    removedEndpoints: Array.from(leftSet).filter((endpoint) => !rightSet.has(endpoint)).sort(),
    changedPositions: changedPositions.slice(0, MAX_SEQUENCE_MISMATCHES),
    repeatedEndpoints: Array.from(new Set([...left, ...right]))
      .map((endpoint) => ({
        endpoint,
        leftCount: leftCounts.get(endpoint) ?? 0,
        rightCount: rightCounts.get(endpoint) ?? 0,
      }))
      .filter((entry) => entry.leftCount > 1 || entry.rightCount > 1)
      .sort((leftEntry, rightEntry) =>
        Math.max(rightEntry.leftCount, rightEntry.rightCount) - Math.max(leftEntry.leftCount, leftEntry.rightCount),
      ),
  };
}

function collectEndpointStats(sessions: SessionSummary[]) {
  const stats = new Map<string, { count: number; totalDurationMs: number; statusCodes: Record<string, number> }>();

  for (const session of sessions) {
    const endpoint = normalizeEndpoint(session);
    const current = stats.get(endpoint) ?? { count: 0, totalDurationMs: 0, statusCodes: {} };
    current.count += 1;
    current.totalDurationMs += finiteNumber(session.durationMs);
    current.statusCodes[String(session.statusCode)] = (current.statusCodes[String(session.statusCode)] ?? 0) + 1;
    stats.set(endpoint, current);
  }

  return stats;
}

function getEndpointKind(leftCount: number, rightCount: number): SessionCompareEndpointRow["kind"] {
  if (leftCount === 0 && rightCount > 0) {
    return "added";
  }
  if (leftCount > 0 && rightCount === 0) {
    return "removed";
  }
  return leftCount === rightCount ? "unchanged" : "changed";
}

function normalizeDomainFilter(domainFilter: string[]) {
  return Array.from(new Set(domainFilter.map(normalizeHost).filter(Boolean))).sort();
}

function normalizeHost(host: string) {
  return host.trim().toLowerCase();
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function compareIso(left: string, right: string) {
  return dateMs(left) - dateMs(right);
}

function dateMs(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function countStatusCodes(sessions: SessionSummary[]) {
  return sessions.reduce<Record<string, number>>((acc, session) => {
    acc[String(session.statusCode)] = (acc[String(session.statusCode)] ?? 0) + 1;
    return acc;
  }, {});
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countByValue(items: string[]) {
  return countBy(items, (item) => item);
}

function countSessionsInBucket(sessions: SessionSummary[], bucketStart: number, bucketMs: number) {
  const bucketEnd = bucketStart + bucketMs;
  return sessions.filter((session) => {
    const startedAt = dateMs(session.startedAt);
    return startedAt >= bucketStart && startedAt < bucketEnd;
  }).length;
}

function percentage(count: number, total: number) {
  return total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
