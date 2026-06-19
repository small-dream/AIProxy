import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";

import type { GetInsightsInput, InsightsResult } from "@aiproxy/shared-types";

import {
  areSessionIdsEqual,
  computeInsightsFromSummaries,
  normalizeHostValue,
  type InsightsComputationFilters,
} from "@/features/insights/compute-insights.helpers";
import type { HostContextMenuState } from "@/features/insights/components/HostContextMenu";
import { useInsightsFilterStore } from "@/features/insights/insights-filter.store";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useThrottledValue } from "@/hooks/use-throttled-value";
import { useI18n } from "@/i18n";
import { invokeGetInsights } from "@/services/commands/sessions";

export function useInsightsData() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // --- Store state ---

  const activeSessionIds = useSessionContainerStore((s) => s.activeSessionIds);
  const activeSessionSummaries = useSessionContainerStore((s) => s.activeSessionSummaries);
  const domainFilter = useInsightsFilterStore((s) => s.domainFilter);
  const setDomainFilter = useInsightsFilterStore((s) => s.setDomainFilter);
  const excludedHosts = useInsightsFilterStore((s) => s.excludedHosts);
  const setExcludedHosts = useInsightsFilterStore((s) => s.setExcludedHosts);
  const hostExact = useInsightsFilterStore((s) => s.hostExact);
  const setHostExact = useInsightsFilterStore((s) => s.setHostExact);
  const resetFilters = useInsightsFilterStore((s) => s.resetFilters);

  // --- Local state ---

  const [debouncedDomain, setDebouncedDomain] = useState("");
  const [hostContextMenu, setHostContextMenu] = useState<HostContextMenuState | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Callbacks ---

  const handleDomainChange = useCallback(
    (value: string) => {
      setDomainFilter(value);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        setDebouncedDomain(value);
      }, 300);
    },
    [setDomainFilter],
  );

  const applyImmediateDomainFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      setDomainFilter(value);
      setDebouncedDomain(value);
    },
    [setDomainFilter],
  );

  const handleFilterHost = useCallback(
    (host: string) => {
      const trimmedHost = host.trim();

      if (!trimmedHost) {
        return;
      }

      setHostExact(trimmedHost);
      setExcludedHosts(
        excludedHosts.filter(
          (currentHost) => normalizeHostValue(currentHost) !== normalizeHostValue(trimmedHost),
        ),
      );
    },
    [setHostExact, setExcludedHosts, excludedHosts],
  );

  const handleFilterSelectedHostText = useCallback(
    (value: string) => {
      applyImmediateDomainFilter(value.trim());
      setHostExact(null);
    },
    [applyImmediateDomainFilter, setHostExact],
  );

  const handleExcludeHost = useCallback(
    (host: string) => {
      const trimmedHost = host.trim();

      if (!trimmedHost) {
        return;
      }

      setHostExact(
        normalizeHostValue(hostExact ?? "") === normalizeHostValue(trimmedHost) ? null : hostExact,
      );
      setExcludedHosts(
        excludedHosts.some(
          (currentHost) => normalizeHostValue(currentHost) === normalizeHostValue(trimmedHost),
        )
          ? excludedHosts
          : [...excludedHosts, trimmedHost],
      );
    },
    [setHostExact, setExcludedHosts, hostExact, excludedHosts],
  );

  const handleCopyHost = useCallback(
    (host: string) => {
      void navigator.clipboard?.writeText(host);
      setSnackbarMessage(t("contextMenu.copiedToClipboard"));
    },
    [t],
  );

  const handleOpenSessionsForHost = useCallback(
    (host: string) => {
      navigate("/", {
        state: {
          sessionHostFilter: {
            host,
            requestedAt: Date.now(),
          },
        },
      });
    },
    [navigate],
  );

  const handleHostContextMenu = useCallback((host: string, event: ReactMouseEvent) => {
    event.preventDefault();

    const selectedText = window.getSelection()?.toString().trim();
    const selectedHostText =
      selectedText && normalizeHostValue(host).includes(normalizeHostValue(selectedText))
        ? selectedText
        : undefined;
    setHostContextMenu({
      anchorPosition: { left: event.clientX - 2, top: event.clientY - 4 },
      host,
      ...(selectedHostText ? { selectedText: selectedHostText } : {}),
    });
  }, []);

  const handleHostContextMenuClose = useCallback(() => {
    setHostContextMenu(null);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // --- Computed ---

  const insightsFilters = useMemo<InsightsComputationFilters>(
    () => ({
      excludedHosts,
      hostExact,
      hostKeyword: debouncedDomain,
    }),
    [debouncedDomain, excludedHosts, hostExact],
  );

  // Throttle the (already batched) session summaries before recomputing the
  // frontend insights, so a sustained burst of traffic can't push the O(n)
  // aggregation onto the main thread faster than ~150ms per pass.
  const throttledSummaries = useThrottledValue(activeSessionSummaries, 150);
  // The backend query is keyed (and gated) by a 5s-debounced snapshot of the
  // active session ids, so a burst of new sessions doesn't trigger a query on
  // every tick. `input` MUST be built from the same debounced ids: the cached
  // result is keyed by them, so building it from the fresher live ids would let
  // the two drift (and keep serving a stale result until the key catches up).
  const debouncedSessionIds = useDebouncedValue(activeSessionIds, 5000);
  const input = useMemo<GetInsightsInput>(() => {
    const base: GetInsightsInput = { sessionIds: debouncedSessionIds };
    const trimmedKeyword = debouncedDomain.trim();
    const trimmedExactHost = hostExact?.trim() ?? "";
    const filteredExcludedHosts = excludedHosts.map((host) => host.trim()).filter(Boolean);

    return {
      ...base,
      ...(filteredExcludedHosts.length > 0 ? { excludedHosts: filteredExcludedHosts } : {}),
      ...(trimmedExactHost ? { hostExact: trimmedExactHost } : {}),
      ...(trimmedKeyword ? { hostKeyword: trimmedKeyword } : {}),
    };
  }, [debouncedSessionIds, debouncedDomain, excludedHosts, hostExact]);
  // Keep the previous result while the debounced sessionIds/filter keys change,
  // so the page does not flip back into a loading state every time a fresh
  // query is issued (e.g. when activeSessionIds settles after the 5s debounce).
  const { data: backendData, isLoading, isPlaceholderData } = useQuery({
    queryKey: ["insights", debouncedSessionIds, debouncedDomain, hostExact, excludedHosts],
    queryFn: () => invokeGetInsights(input),
    enabled: debouncedSessionIds.length > 0,
    placeholderData: keepPreviousData,
  });
  const fallbackData = useMemo(
    () => computeInsightsFromSummaries(throttledSummaries, insightsFilters),
    [throttledSummaries, insightsFilters],
  );
  // Real-time path: drive the view from the live frontend computation while the
  // live session ids have diverged from the debounced backend snapshot — either
  // because sessions are still being captured (the snapshot lags ~5s) or because
  // the user switched to a different session set of the SAME length, which a
  // length-only check would miss (it would keep serving the stale backend result
  // for the whole debounce window). Compare contents, not just length. The
  // frontend path also wins while the backend result is a placeholder carried
  // over from the previous query key. Both paths are numerically equivalent; the
  // persisted backend result only takes over once the ids realign AND it
  // reflects the current snapshot.
  const isCapturing = useMemo(
    () => !areSessionIdsEqual(activeSessionIds, debouncedSessionIds),
    [activeSessionIds, debouncedSessionIds],
  );
  const data: InsightsResult =
    !isCapturing && !isPlaceholderData && backendData !== undefined && backendData.totalRequests > 0
      ? backendData
      : fallbackData.totalRequests > 0
        ? fallbackData
        : (backendData ?? fallbackData);
  const hasAnyData = Boolean(backendData) || fallbackData.totalRequests > 0;
  // Only show the full-page loader when there is genuinely nothing to render:
  // the backend query is fetching for the first time AND the frontend fallback
  // has no data. Background refetches (re-keyed by debounced sessionIds) keep
  // the previous result via keepPreviousData, so they stay on the content view
  // instead of flickering the page back to a spinner.
  const showLoading = isLoading && !hasAnyData;
  const hasActiveFilters = Boolean(debouncedDomain.trim() || hostExact || excludedHosts.length > 0);
  const filteredOutAllData = hasActiveFilters && data.totalRequests === 0;

  return {
    // Data
    data,
    showLoading,
    hasActiveFilters,
    filteredOutAllData,

    // Filter state
    domainFilter,
    debouncedDomain,
    hostExact,
    excludedHosts,

    // Context menu
    hostContextMenu,

    // Snackbar
    snackbarMessage,

    // Callbacks
    handleDomainChange,
    applyImmediateDomainFilter,
    handleFilterHost,
    handleFilterSelectedHostText,
    handleExcludeHost,
    handleCopyHost,
    handleOpenSessionsForHost,
    handleHostContextMenu,
    handleHostContextMenuClose,
    setSnackbarMessage,
    setHostExact,
    setExcludedHosts,
    resetFilters,

    // i18n
    t,
  };
}
