import type { SessionSummary } from "@pharles/shared-types";

export type SessionHostGroup = {
  host: string;
  latestStartedAt: string;
  sessions: SessionSummary[];
  totalCount: number;
};

export function buildSessionHostGroups(
  sessions: SessionSummary[],
  keyword: string,
): SessionHostGroup[] {
  const groupsByHost = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    if (!matchesKeyword(session, keyword)) {
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
    .sort((left, right) => left.host.localeCompare(right.host));
}

export function reconcileExpandedHosts(
  expandedHosts: string[],
  groups: SessionHostGroup[],
): string[] {
  const availableHosts = new Set(groups.map((group) => group.host));

  return expandedHosts.filter((host) => availableHosts.has(host));
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
