import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import FilterAltOffRoundedIcon from "@mui/icons-material/FilterAltOffRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputBase,
  inputBaseClasses,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  alpha,
  darken,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

import type { AppShellOutletContext } from "@/components/layout/app-shell.types";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
import { downloadTextFile } from "@/lib/download";
import { useI18n, type TranslationKey } from "@/i18n";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useInsightsFilterStore } from "@/features/insights/insights-filter.store";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuDividerSx,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "@/features/sessions/components/context-menu.styles";
import type { GetInsightsInput, InsightsResult, SessionSummary } from "@aiproxy/shared-types";
import { invokeGetInsights } from "@/services/commands/sessions";

type HostContextMenuState = {
  anchorPosition: { left: number; top: number };
  host: string;
  selectedText?: string;
};

type InsightsComputationFilters = {
  excludedHosts: string[];
  hostExact: string | null;
  hostKeyword: string;
};

const EMPTY_INSIGHTS_RESULT: InsightsResult = {
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

function normalizeHostValue(host: string): string {
  return host.trim().toLowerCase();
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
        <Typography color="text.secondary" sx={{ fontSize: 12, fontWeight: 600, mb: 0.25 }}>
          {label}
        </Typography>
        <Typography sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>{value}</Typography>
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

function HostContextMenu({
  anchorPosition,
  host,
  hostExact,
  selectedText,
  onClose,
  onCopyHost,
  onExcludeHost,
  onFilterHost,
  onFilterSelection,
  onOpenSessions,
}: {
  anchorPosition: { left: number; top: number } | undefined;
  host: string | null;
  hostExact: string | null;
  selectedText?: string | undefined;
  onClose: () => void;
  onCopyHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onFilterHost: (host: string) => void;
  onFilterSelection: (value: string) => void;
  onOpenSessions: (host: string) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!host) {
    return null;
  }

  const isExactHostActive = normalizeHostValue(hostExact ?? "") === normalizeHostValue(host);
  const menuItemSx = getContextMenuItemSx(theme);
  const iconSx = getContextMenuIconSx(theme);
  const dividerSx = getContextMenuDividerSx(theme);

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={buildContextMenuSlotProps(220)}
    >
      <MenuItem
        disabled={isExactHostActive}
        onClick={() => {
          onFilterHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <FilterAltRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.filterByHost")}
        </ListItemText>
      </MenuItem>

      {selectedText && normalizeHostValue(selectedText) !== normalizeHostValue(host) ? (
        <MenuItem
          onClick={() => {
            onFilterSelection(selectedText);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <SearchRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>
            {t("insightsPage.hosts.contextMenu.filterBySelection")}
          </ListItemText>
        </MenuItem>
      ) : null}

      <MenuItem
        onClick={() => {
          onExcludeHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <FilterAltOffRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.excludeHost")}
        </ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem
        onClick={() => {
          onCopyHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.copyHost")}
        </ListItemText>
      </MenuItem>

      <MenuItem
        onClick={() => {
          onOpenSessions(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <OpenInNewRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.showRequests")}
        </ListItemText>
      </MenuItem>
    </Menu>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function InsightsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { setHeaderActions } = useOutletContext<AppShellOutletContext>();

  const activeSessionIds = useSessionContainerStore((s) => s.activeSessionIds);
  const activeSessionSummaries = useSessionContainerStore((s) => s.activeSessionSummaries);
  const domainFilter = useInsightsFilterStore((s) => s.domainFilter);
  const setDomainFilter = useInsightsFilterStore((s) => s.setDomainFilter);
  const excludedHosts = useInsightsFilterStore((s) => s.excludedHosts);
  const setExcludedHosts = useInsightsFilterStore((s) => s.setExcludedHosts);
  const hostExact = useInsightsFilterStore((s) => s.hostExact);
  const setHostExact = useInsightsFilterStore((s) => s.setHostExact);
  const resetFilters = useInsightsFilterStore((s) => s.resetFilters);
  const [debouncedDomain, setDebouncedDomain] = useState("");
  const [hostContextMenu, setHostContextMenu] = useState<HostContextMenuState | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDomainChange = useCallback((value: string) => {
    setDomainFilter(value);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedDomain(value);
    }, 300);
  }, [setDomainFilter]);

  const applyImmediateDomainFilter = useCallback((value: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    setDomainFilter(value);
    setDebouncedDomain(value);
  }, [setDomainFilter]);

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
  const { data: backendData, isLoading } = useQuery({
    queryKey: ["insights", debouncedSessionIds, debouncedDomain, hostExact, excludedHosts],
    queryFn: () => invokeGetInsights(input),
    enabled: activeSessionIds.length > 0,
  });
  const fallbackData = useMemo(
    () => computeInsightsFromSummaries(activeSessionSummaries, insightsFilters),
    [activeSessionSummaries, insightsFilters],
  );
  const data =
    backendData && backendData.totalRequests > 0
      ? backendData
      : fallbackData.totalRequests > 0
        ? fallbackData
        : (backendData ?? fallbackData);
  const hasActiveFilters = Boolean(debouncedDomain.trim() || hostExact || excludedHosts.length > 0);
  const filteredOutAllData = hasActiveFilters && data.totalRequests === 0;
  const slowRequestMaxDuration =
    data?.slowRequests.reduce((maxDuration, req) => Math.max(maxDuration, req.durationMs), 0) ?? 0;

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

  if (data.totalRequests === 0 && !hasActiveFilters) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", minHeight: 240 }}>
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
            bgcolor: alpha(
              theme.palette.background.paper,
              theme.palette.mode === "dark" ? 0.94 : 0.98,
            ),
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
        {hasActiveFilters ? (
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              alignItems: "center",
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {debouncedDomain.trim() ? (
              <Chip
                label={t("insightsPage.filter.keywordChip", { value: debouncedDomain.trim() })}
                onDelete={() => applyImmediateDomainFilter("")}
                size="small"
                variant="outlined"
                sx={{ fontSize: 12, maxWidth: 220 }}
              />
            ) : null}
            {hostExact ? (
              <Chip
                color="primary"
                label={t("insightsPage.filter.hostChip", { host: hostExact })}
                onDelete={() => setHostExact(null)}
                size="small"
                variant="outlined"
                sx={{ fontSize: 12, maxWidth: 260 }}
              />
            ) : null}
            {excludedHosts.map((host) => (
              <Chip
                color="warning"
                key={host}
                label={t("insightsPage.filter.excludeChip", { host })}
                onDelete={() =>
                  setExcludedHosts(
                    excludedHosts.filter(
                      (currentHost) => normalizeHostValue(currentHost) !== normalizeHostValue(host),
                    ),
                  )
                }
                size="small"
                variant="outlined"
                sx={{ fontSize: 12, maxWidth: 260 }}
              />
            ))}
            <Chip
              label={t("insightsPage.filter.clearAll")}
              onClick={() => {
                applyImmediateDomainFilter("");
                resetFilters();
              }}
              size="small"
              sx={{ fontSize: 12 }}
            />
          </Stack>
        ) : null}
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
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.94 : 0.98,
          ),
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
        {filteredOutAllData ? (
          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 180 }}>
            <Typography color="text.secondary" sx={{ fontSize: 13 }}>
              {t("insightsPage.states.noFilteredData")}
            </Typography>
          </Stack>
        ) : null}

        {!filteredOutAllData && (
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
        )}

        {!filteredOutAllData && data.byHost.length > 0 && (
          <Box sx={{ mb: 2.25 }}>
            <SectionTitle>{t("insightsPage.hosts.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>
                    {t("insightsPage.hosts.host")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.hosts.requests")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.hosts.errors")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.hosts.avgDuration")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.hosts.p95Duration")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.hosts.traffic")}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byHost.map((host) => (
                  <TableRow
                    hover
                    key={host.host}
                    onClick={() => handleOpenSessionsForHost(host.host)}
                    onContextMenu={(event) => handleHostContextMenu(host.host, event)}
                    sx={{
                      cursor: "pointer",
                      "&:last-child td": { borderBottom: 0 },
                      "& .host-filter-action": {
                        opacity: 0,
                      },
                      "&:hover .host-filter-action, &:focus-within .host-filter-action": {
                        opacity: 1,
                      },
                    }}
                  >
                    <TableCell sx={{ fontSize: 13, fontFamily: "monospace" }}>
                      <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, minWidth: 0 }}>
                        <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          {host.host}
                        </Box>
                        <Tooltip arrow title={t("insightsPage.hosts.contextMenu.filterByHost")}>
                          <IconButton
                            aria-label={t("insightsPage.hosts.contextMenu.filterByHost")}
                            className="host-filter-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleFilterHost(host.host);
                            }}
                            size="small"
                            sx={{
                              height: 22,
                              transition: "opacity 120ms ease, background-color 120ms ease",
                              width: 22,
                            }}
                          >
                            <FilterAltRoundedIcon sx={{ fontSize: 15 }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>
                      {formatNumber(host.requestCount)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>
                      {formatNumber(host.errorCount)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>
                      {formatDuration(host.avgDurationMs)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>
                      {formatDuration(host.p95DurationMs)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: 13 }}>
                      {formatBytes(host.totalBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}

        {!filteredOutAllData && (
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
        )}

        {!filteredOutAllData && data.slowRequests.length > 0 && (
          <Box>
            <SectionTitle>{t("insightsPage.slowRequests.title")}</SectionTitle>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>
                    {t("insightsPage.slowRequests.url")}
                  </TableCell>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}>
                    {t("insightsPage.slowRequests.method")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.slowRequests.status")}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ color: "text.secondary", fontWeight: 700, fontSize: 12 }}
                  >
                    {t("insightsPage.slowRequests.duration")}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.slowRequests.map((req) => {
                  const urlSummary = summarizeUrl(req.url);
                  const durationIntensity = getDurationIntensity(
                    req.durationMs,
                    slowRequestMaxDuration,
                  );

                  return (
                    <TableRow
                      hover
                      key={req.sessionId}
                      onClick={() =>
                        navigate("/", {
                          state: {
                            sessionSelect: {
                              sessionId: req.sessionId,
                              requestedAt: Date.now(),
                            },
                          },
                        })
                      }
                      sx={{ cursor: "pointer", "&:last-child td": { borderBottom: 0 } }}
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
                          color:
                            req.statusCode >= 400
                              ? theme.palette.error.main
                              : theme.palette.success.main,
                          fontSize: 13,
                          fontWeight: 700,
                        })}
                      >
                        {req.statusCode}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={(theme) => ({
                          bgcolor: alpha(
                            theme.palette.warning.main,
                            0.08 + durationIntensity * 0.16,
                          ),
                          borderRadius: 0.5,
                          color:
                            durationIntensity > 0.85
                              ? darken(
                                  theme.palette.warning.main,
                                  theme.palette.mode === "dark" ? 0 : 0.25,
                                )
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

      <HostContextMenu
        anchorPosition={hostContextMenu?.anchorPosition}
        host={hostContextMenu?.host ?? null}
        hostExact={hostExact}
        selectedText={hostContextMenu?.selectedText}
        onClose={handleHostContextMenuClose}
        onCopyHost={handleCopyHost}
        onExcludeHost={handleExcludeHost}
        onFilterHost={handleFilterHost}
        onFilterSelection={handleFilterSelectedHostText}
        onOpenSessions={handleOpenSessionsForHost}
      />

      <Snackbar
        autoHideDuration={2200}
        message={snackbarMessage}
        onClose={() => setSnackbarMessage(null)}
        open={Boolean(snackbarMessage)}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Markdown report builder
// ---------------------------------------------------------------------------

function buildMarkdownReport(data: InsightsResult, t: (key: TranslationKey) => string): string {
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
