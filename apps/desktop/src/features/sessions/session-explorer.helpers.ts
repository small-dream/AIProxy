import type { SessionSummary } from "@pharles/shared-types";

export type SessionExplorerScope = "all" | "http" | "errors";

export type SessionHostGroup = {
  host: string;
  latestStartedAt: string;
  sessions: SessionSummary[];
  totalCount: number;
};

export function buildSessionHostGroups(
  sessions: SessionSummary[],
  keyword: string,
  scope: SessionExplorerScope,
): SessionHostGroup[] {
  const groupsByHost = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    if (!matchesScope(session, scope) || !matchesKeyword(session, keyword)) {
      continue;
    }

    const host = normalizeHost(session.host);
    const existingGroup = groupsByHost.get(host) ?? [];

    existingGroup.push(session);
    groupsByHost.set(host, existingGroup);
  }

  return Array.from(groupsByHost.entries())
    .map(([host, groupedSessions]) => {
      const sortedSessions = sortSessionsByStartedAt(groupedSessions);

      return {
        host,
        latestStartedAt: sortedSessions[0]?.startedAt ?? "",
        sessions: sortedSessions,
        totalCount: sortedSessions.length,
      };
    })
    .sort((left, right) => {
      const timeDelta = Date.parse(right.latestStartedAt) - Date.parse(left.latestStartedAt);

      if (!Number.isNaN(timeDelta) && timeDelta !== 0) {
        return timeDelta;
      }

      return left.host.localeCompare(right.host);
    });
}

function matchesScope(session: SessionSummary, scope: SessionExplorerScope): boolean {
  if (scope === "errors") {
    return session.statusCode >= 400;
  }

  if (scope === "http") {
    return session.protocol.toLowerCase().startsWith("http");
  }

  return true;
}

function matchesKeyword(session: SessionSummary, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();

  if (normalizedKeyword.length === 0) {
    return true;
  }

  const haystacks = [session.host, session.path, session.url, session.method, String(session.statusCode)];

  return haystacks.some((value) => value.toLowerCase().includes(normalizedKeyword));
}

function normalizeHost(host: string): string {
  const normalizedHost = host.trim();

  return normalizedHost.length > 0 ? normalizedHost : "<unknown>";
}

function sortSessionsByStartedAt(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}
