import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";

import type { GetInsightsInput, InsightsResult } from "@aiproxy/shared-types";

import {
  buildMarkdownReport,
  computeInsightsFromSummaries,
  normalizeHostValue,
  type InsightsComputationFilters,
} from "@/features/insights/compute-insights.helpers";
import type { HostContextMenuState } from "@/features/insights/components/HostContextMenu";
import { useInsightsFilterStore } from "@/features/insights/insights-filter.store";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { downloadTextFile } from "@/lib/download";
import { useI18n } from "@/i18n";
import { invokeGetInsights } from "@/services/commands/sessions";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { useOutletContext } from "react-router-dom";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import { Menu, MenuItem } from "@mui/material";

export function useInsightsData() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();

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

  const input = useMemo<GetInsightsInput>(() => {
    const base: GetInsightsInput = { sessionIds: activeSessionIds };
    const trimmedKeyword = debouncedDomain.trim();
    const trimmedExactHost = hostExact?.trim() ?? "";
    const filteredExcludedHosts = excludedHosts.map((host) => host.trim()).filter(Boolean);

    return {
      ...base,
      ...(filteredExcludedHosts.length > 0 ? { excludedHosts: filteredExcludedHosts } : {}),
      ...(trimmedExactHost ? { hostExact: trimmedExactHost } : {}),
      ...(trimmedKeyword ? { hostKeyword: trimmedKeyword } : {}),
    };
  }, [activeSessionIds, debouncedDomain, excludedHosts, hostExact]);

  const debouncedSessionIds = useDebouncedValue(activeSessionIds, 5000);
  // Keep the previous result while the debounced sessionIds/filter keys change,
  // so the page does not flip back into a loading state every time a fresh
  // query is issued (e.g. when activeSessionIds settles after the 5s debounce).
  const { data: backendData, isLoading } = useQuery({
    queryKey: ["insights", debouncedSessionIds, debouncedDomain, hostExact, excludedHosts],
    queryFn: () => invokeGetInsights(input),
    enabled: activeSessionIds.length > 0,
    placeholderData: keepPreviousData,
  });
  const fallbackData = useMemo(
    () => computeInsightsFromSummaries(activeSessionSummaries, insightsFilters),
    [activeSessionSummaries, insightsFilters],
  );
  const data: InsightsResult =
    backendData && backendData.totalRequests > 0
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
  const slowRequestMaxDuration =
    data?.slowRequests.reduce((maxDuration, req) => Math.max(maxDuration, req.durationMs), 0) ?? 0;

  // --- Export ---

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
          disabled={data.totalRequests === 0}
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
          <MenuItem onClick={() => handleExport("json")}>{t("insightsPage.export.json")}</MenuItem>
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

  return {
    // Data
    data,
    showLoading,
    hasActiveFilters,
    filteredOutAllData,
    slowRequestMaxDuration,

    // Filter state
    domainFilter,
    debouncedDomain,
    hostExact,
    excludedHosts,

    // Context menu
    hostContextMenu,

    // Snackbar
    snackbarMessage,

    // Export
    handleExport,
    exportAnchorEl,

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
