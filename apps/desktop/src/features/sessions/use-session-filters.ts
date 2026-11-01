import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DEFAULT_WORKSPACE_ID, type SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { listThrottledSessionIds } from "@/services/commands";
import { buildSessionHostGroups } from "@/features/sessions/session-explorer.helpers";
import { readStorageValue, readStoredHosts } from "@/features/sessions/session-ui.helpers";
import type { SessionContainer } from "@/features/sessions/session-containers.helpers";

export const FOCUSED_HOSTS_STORAGE_KEY = "aiproxy.sessions.focusedHosts";
export const IGNORED_HOSTS_STORAGE_KEY = "aiproxy.sessions.ignoredHosts";
const COMPARE_BASE_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.compareBaseSessionId";

function readFocusedHostsFromStorage(): Set<string> {
  return new Set(readStoredHosts(FOCUSED_HOSTS_STORAGE_KEY));
}

export interface SessionFiltersState {
  focusedHosts: Set<string>;
  setFocusedHosts: React.Dispatch<React.SetStateAction<Set<string>>>;
  ignoredHosts: Set<string>;
  setIgnoredHosts: React.Dispatch<React.SetStateAction<Set<string>>>;
  showOnlyThrottled: boolean;
  setShowOnlyThrottled: React.Dispatch<React.SetStateAction<boolean>>;
  compareBaseSessionId: string;
  setCompareBaseSessionId: React.Dispatch<React.SetStateAction<string>>;
  hostGroups: ReturnType<typeof buildSessionHostGroups>;
  visibleSessions: SessionSummary[];
  toggleHost: (host: string) => void;
}

export interface UseSessionFiltersParams {
  /** Pre-computed display sessions (with timeout markers applied). */
  displayActiveSessions: SessionSummary[];
  /** The parent's `updateContainer` callback for applying filter changes. */
  updateContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
  /** The container's search value. */
  searchValue: string;
  /**
   * Workspace the running proxy captures into. Throttle runs are recorded with
   * it, so the throttled-session filter must query the same workspace (P2-8);
   * before the first status poll it falls back to the default workspace.
   */
  activeWorkspaceId?: string | undefined;
}

export function useSessionFilters({
  displayActiveSessions,
  updateContainer,
  searchValue,
  activeWorkspaceId,
}: UseSessionFiltersParams): SessionFiltersState {
  const { t } = useI18n();

  const [focusedHosts, setFocusedHosts] = useState<Set<string>>(() =>
    readFocusedHostsFromStorage(),
  );
  const [ignoredHosts, setIgnoredHosts] = useState<Set<string>>(
    () => new Set(readStoredHosts(IGNORED_HOSTS_STORAGE_KEY)),
  );
  const [showOnlyThrottled, setShowOnlyThrottled] = useState(false);
  const [compareBaseSessionId, setCompareBaseSessionId] = useState(
    () => readStorageValue(COMPARE_BASE_SESSION_ID_STORAGE_KEY) ?? "",
  );

  const throttledWorkspaceId = activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const { data: throttledSessionIds = [] } = useQuery({
    // P2-8: scope both the cache key and the query to the workspace the proxy
    // is actually recording into. The literal "default" key used to return an
    // empty list (and never refetch on a workspace switch) for every non-default
    // workspace.
    queryKey: ["throttled-session-ids", throttledWorkspaceId],
    queryFn: () => listThrottledSessionIds(throttledWorkspaceId),
    refetchInterval: 2_000,
    // Only poll while the filter is on; the ids have no other consumer.
    enabled: showOnlyThrottled,
  });
  const throttledSessionIdSet = useMemo(() => new Set(throttledSessionIds), [throttledSessionIds]);

  const filteredByIgnoreSessions = useMemo(() => {
    if (ignoredHosts.size === 0) {
      return displayActiveSessions;
    }
    return displayActiveSessions.filter((session) => !ignoredHosts.has(session.host));
  }, [displayActiveSessions, ignoredHosts]);

  const filteredByThrottleSessions = useMemo(() => {
    if (!showOnlyThrottled) {
      return filteredByIgnoreSessions;
    }
    return filteredByIgnoreSessions.filter((session) => throttledSessionIdSet.has(session.id));
  }, [filteredByIgnoreSessions, showOnlyThrottled, throttledSessionIdSet]);

  const hostGroups = useMemo(
    () =>
      buildSessionHostGroups(filteredByThrottleSessions, searchValue, {
        focusedHosts,
        unfocusedLabel: t("sessionExplorer.unfocusedGroup"),
        unknownHostLabel: t("sessionExplorer.unknownHost"),
      }),
    [searchValue, filteredByThrottleSessions, focusedHosts, t],
  );

  const visibleSessions = useMemo(
    () => hostGroups.flatMap((group) => group.sessions),
    [hostGroups],
  );

  const toggleHost = (host: string) => {
    updateContainer((container: SessionContainer) => ({
      ...container,
      expandedHosts: container.expandedHosts.includes(host)
        ? container.expandedHosts.filter((currentHost: string) => currentHost !== host)
        : [...container.expandedHosts, host],
    }));
  };

  return {
    focusedHosts,
    setFocusedHosts,
    ignoredHosts,
    setIgnoredHosts,
    showOnlyThrottled,
    setShowOnlyThrottled,
    compareBaseSessionId,
    setCompareBaseSessionId,
    hostGroups,
    visibleSessions,
    toggleHost,
  };
}
