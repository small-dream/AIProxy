import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  alpha,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  InputBase,
  inputBaseClasses,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  darken,
} from "@mui/material";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { SlowRequest } from "@aiproxy/shared-types";

import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  getIntensity,
  normalizeHostValue,
  summarizeUrl,
} from "@/features/insights/compute-insights.helpers";
import { getMethodColor } from "@/features/sessions/components/session-inspector.helpers";
import { HostContextMenu } from "@/features/insights/components/HostContextMenu";
import { useInsightsData } from "@/features/insights/use-insights-data";
import { useI18n } from "@/i18n";

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

// ---------------------------------------------------------------------------
// Virtualized request ranking table
// ---------------------------------------------------------------------------

// A fixed row height lets the virtualizer window the list (only visible rows +
// overscan are in the DOM), so a host with thousands of requests scrolls as
// smoothly as twenty. The two-line URL cell (method pill + path, plus the
// host/query sub-line) fits within this height.
const INSIGHTS_REQUEST_ROW_HEIGHT = 48;
const INSIGHTS_REQUEST_OVERSCAN = 8;
// The panel flexes to fill the remaining space inside the insights card, but
// keeps a floor so it stays usable when the host/distribution sections above
// are tall enough to push the card into scrolling.
const INSIGHTS_REQUEST_PANEL_MIN_HEIGHT = 220;
// Shared between the sticky header and every row so the columns line up.
const INSIGHTS_REQUEST_GRID_COLUMNS = "minmax(200px, 1fr) 56px 88px 88px";

function RequestRankingRow({
  req,
  maxDuration,
  maxSize,
}: {
  maxDuration: number;
  maxSize: number;
  req: SlowRequest;
}) {
  const urlSummary = summarizeUrl(req.url);
  const durationIntensity = getIntensity(req.durationMs, maxDuration);
  const sizeIntensity = getIntensity(req.sizeBytes, maxSize);

  return (
    <Box
      sx={{
        columnGap: 1.5,
        display: "grid",
        gridTemplateColumns: INSIGHTS_REQUEST_GRID_COLUMNS,
        height: "100%",
        minWidth: 0,
        px: 1.5,
      }}
    >
      <Box
        sx={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}
        title={req.url}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
          <Chip
            color={getMethodColor(req.method)}
            label={req.method.toUpperCase()}
            size="small"
            variant="outlined"
            sx={{ flexShrink: 0 }}
          />
          <Typography
            component="span"
            noWrap
            sx={{
              fontFamily: "monospace",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.35,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {urlSummary.primary}
          </Typography>
        </Stack>
        <Typography color="text.secondary" noWrap sx={{ fontFamily: "monospace", fontSize: 12 }}>
          {[urlSummary.host, urlSummary.secondary].filter(Boolean).join("  ")}
        </Typography>
      </Box>
      <Box sx={{ alignItems: "center", display: "flex", justifyContent: "flex-end" }}>
        <Typography
          sx={(theme) => ({
            color: req.statusCode >= 400 ? theme.palette.error.main : theme.palette.success.main,
            fontSize: 13,
            fontWeight: 700,
          })}
        >
          {req.statusCode}
        </Typography>
      </Box>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.info.main, 0.06 + sizeIntensity * 0.14),
          borderRadius: 0.5,
          // Inset vertically so the tinted block clears the row's top/bottom
          // divider lines instead of sitting flush on top of them.
          my: 0.5,
          color:
            sizeIntensity > 0.85
              ? darken(theme.palette.info.main, theme.palette.mode === "dark" ? 0 : 0.25)
              : "text.primary",
          display: "flex",
          fontFamily: "monospace",
          fontSize: 13,
          fontWeight: 700,
          justifyContent: "flex-end",
          pr: 0.75,
          whiteSpace: "nowrap",
        })}
      >
        {formatBytes(req.sizeBytes)}
      </Box>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.warning.main, 0.08 + durationIntensity * 0.16),
          borderRadius: 0.5,
          // See Size cell: keep the tinted block clear of the row dividers.
          my: 0.5,
          color:
            durationIntensity > 0.85
              ? darken(theme.palette.warning.main, theme.palette.mode === "dark" ? 0 : 0.25)
              : "text.primary",
          display: "flex",
          fontFamily: "monospace",
          fontSize: 13,
          fontWeight: 700,
          justifyContent: "flex-end",
          pr: 0.75,
          whiteSpace: "nowrap",
        })}
      >
        {formatDuration(req.durationMs)}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function InsightsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const ins = useInsightsData();

  const [requestView, setRequestView] = useState<"largest" | "slow">("slow");
  const rankedRequests =
    requestView === "largest" ? ins.data.largestRequests : ins.data.slowRequests;
  // Intensity is relative to the currently displayed ranking set, so both
  // metric columns stay meaningful regardless of which ranking is active.
  const maxDuration = rankedRequests.reduce((max, req) => Math.max(max, req.durationMs), 0);
  const maxSize = rankedRequests.reduce((max, req) => Math.max(max, req.sizeBytes), 0);

  const requestsScrollRef = useRef<HTMLDivElement>(null);
  const requestsVirtualizer = useVirtualizer({
    count: rankedRequests.length,
    getScrollElement: () => requestsScrollRef.current,
    estimateSize: () => INSIGHTS_REQUEST_ROW_HEIGHT,
    overscan: INSIGHTS_REQUEST_OVERSCAN,
  });

  if (ins.showLoading) {
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

  if (ins.data.totalRequests === 0 && !ins.hasActiveFilters) {
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
          value={ins.domainFilter}
          onChange={(e) => ins.handleDomainChange(e.target.value)}
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
        {ins.hasActiveFilters ? (
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
            {ins.debouncedDomain.trim() ? (
              <Chip
                label={t("insightsPage.filter.keywordChip", { value: ins.debouncedDomain.trim() })}
                onDelete={() => ins.applyImmediateDomainFilter("")}
                size="small"
                variant="outlined"
                sx={{ fontSize: 12, maxWidth: 220 }}
              />
            ) : null}
            {ins.hostExact ? (
              <Chip
                color="primary"
                label={t("insightsPage.filter.hostChip", { host: ins.hostExact })}
                onDelete={() => ins.setHostExact(null)}
                size="small"
                variant="outlined"
                sx={{ fontSize: 12, maxWidth: 260 }}
              />
            ) : null}
            {ins.excludedHosts.map((host) => (
              <Chip
                color="warning"
                key={host}
                label={t("insightsPage.filter.excludeChip", { host })}
                onDelete={() =>
                  ins.setExcludedHosts(
                    ins.excludedHosts.filter(
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
                ins.applyImmediateDomainFilter("");
                ins.resetFilters();
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
          {t("insightsPage.scope.current", { count: formatNumber(ins.data.totalRequests) })}
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
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          p: 1.75,
        })}
        variant="outlined"
      >
        {ins.filteredOutAllData ? (
          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 180 }}>
            <Typography color="text.secondary" sx={{ fontSize: 13 }}>
              {t("insightsPage.states.noFilteredData")}
            </Typography>
          </Stack>
        ) : null}

        {!ins.filteredOutAllData && (
          <Stack direction="row" spacing={1.1} sx={{ flexWrap: "wrap", flexShrink: 0, mb: 2.25 }}>
            <OverviewCard
              label={t("insightsPage.overview.totalRequests")}
              tone="primary"
              value={formatNumber(ins.data.totalRequests)}
            />
            <OverviewCard
              label={t("insightsPage.overview.errorRate")}
              tone={ins.data.errorRate > 0 ? "error" : "success"}
              value={formatPercent(ins.data.errorRate)}
            />
            <OverviewCard
              label={t("insightsPage.overview.avgDuration")}
              tone={ins.data.avgDurationMs >= 1000 ? "warning" : "success"}
              value={formatDuration(ins.data.avgDurationMs)}
            />
            <OverviewCard
              label={t("insightsPage.overview.p95Duration")}
              tone={ins.data.p95DurationMs >= 1000 ? "warning" : "success"}
              value={formatDuration(ins.data.p95DurationMs)}
            />
            <OverviewCard
              label={t("insightsPage.overview.totalTraffic")}
              tone="primary"
              value={formatBytes(ins.data.totalBytes)}
            />
          </Stack>
        )}

        {!ins.filteredOutAllData && ins.data.byHost.length > 1 && (
          <Box
            sx={{
              display: "flex",
              flex: ins.hasActiveFilters ? "0 0 auto" : "1 1 0",
              flexDirection: "column",
              minHeight: 0,
              mb: 2.25,
            }}
          >
            <SectionTitle>{t("insightsPage.hosts.title")}</SectionTitle>
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <Table size="small">
                <TableHead
                  sx={{
                    bgcolor: (theme) =>
                      alpha(
                        theme.palette.background.paper,
                        theme.palette.mode === "dark" ? 0.98 : 1,
                      ),
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                  }}
                >
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
                  {ins.data.byHost.map((host) => (
                    <TableRow
                      hover
                      key={host.host}
                      onClick={() => ins.handleOpenSessionsForHost(host.host)}
                      onContextMenu={(event) => ins.handleHostContextMenu(host.host, event)}
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
                        <Stack
                          direction="row"
                          sx={{ alignItems: "center", gap: 0.75, minWidth: 0 }}
                        >
                          <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                            {host.host}
                          </Box>
                          <Tooltip arrow title={t("insightsPage.hosts.contextMenu.filterByHost")}>
                            <IconButton
                              aria-label={t("insightsPage.hosts.contextMenu.filterByHost")}
                              className="host-filter-action"
                              onClick={(event) => {
                                event.stopPropagation();
                                ins.handleFilterHost(host.host);
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
          </Box>
        )}

        {!ins.filteredOutAllData &&
          (ins.data.byStatusCode.length > 1 || ins.data.byMethod.length > 1) && (
            <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", flexShrink: 0, mb: 2.25 }}>
              {ins.data.byStatusCode.length > 1 && (
                <Box sx={{ flex: "1 1 280px", minWidth: 280 }}>
                  <SectionTitle>{t("insightsPage.statusCodes.title")}</SectionTitle>
                  <Stack spacing={0.25}>
                    {ins.data.byStatusCode
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .map((entry) => (
                        <DistributionItem
                          key={entry.statusCode}
                          label={String(entry.statusCode)}
                          count={entry.count}
                          maxCount={ins.data.byStatusCode[0]?.count ?? 0}
                        />
                      ))}
                  </Stack>
                </Box>
              )}

              {ins.data.byMethod.length > 1 && (
                <Box sx={{ flex: "1 1 280px", minWidth: 280 }}>
                  <SectionTitle>{t("insightsPage.methods.title")}</SectionTitle>
                  <Stack spacing={0.25}>
                    {ins.data.byMethod
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .map((entry) => (
                        <DistributionItem
                          key={entry.method}
                          label={entry.method}
                          count={entry.count}
                          maxCount={ins.data.byMethod[0]?.count ?? 0}
                        />
                      ))}
                  </Stack>
                </Box>
              )}
            </Stack>
          )}

        {!ins.filteredOutAllData && ins.hasActiveFilters && rankedRequests.length > 0 && (
          <Box
            sx={{
              display: "flex",
              flex: 1,
              flexDirection: "column",
              minHeight: INSIGHTS_REQUEST_PANEL_MIN_HEIGHT,
            }}
          >
            <ToggleButtonGroup
              exclusive
              onChange={(_event, value) => {
                if (value === "largest" || value === "slow") {
                  setRequestView(value);
                }
              }}
              size="small"
              sx={{ mb: 0.75, mt: 0.5 }}
              value={requestView}
            >
              <ToggleButton value="slow">{t("insightsPage.slowRequests.title")}</ToggleButton>
              <ToggleButton value="largest">{t("insightsPage.largestRequests.title")}</ToggleButton>
            </ToggleButtonGroup>
            <Box
              ref={requestsScrollRef}
              sx={{
                border: "1px solid",
                borderColor: (theme) =>
                  alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
                borderRadius: 1,
                flex: 1,
                minHeight: 0,
                overflow: "auto",
              }}
            >
              <Box
                sx={{
                  alignItems: "center",
                  bgcolor: (theme) =>
                    alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.98 : 1),
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  columnGap: 1.5,
                  display: "grid",
                  gridTemplateColumns: INSIGHTS_REQUEST_GRID_COLUMNS,
                  px: 1.5,
                  py: 0.5,
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                <Typography sx={{ color: "text.secondary", fontSize: 12, fontWeight: 700 }}>
                  {t("insightsPage.slowRequests.url")}
                </Typography>
                <Typography
                  sx={{
                    color: "text.secondary",
                    fontSize: 12,
                    fontWeight: 700,
                    textAlign: "right",
                  }}
                >
                  {t("insightsPage.slowRequests.status")}
                </Typography>
                <Typography
                  sx={{
                    color: "text.secondary",
                    fontSize: 12,
                    fontWeight: 700,
                    pr: 0.75,
                    textAlign: "right",
                  }}
                >
                  {t("insightsPage.slowRequests.size")}
                </Typography>
                <Typography
                  sx={{
                    color: "text.secondary",
                    fontSize: 12,
                    fontWeight: 700,
                    pr: 0.75,
                    textAlign: "right",
                  }}
                >
                  {t("insightsPage.slowRequests.duration")}
                </Typography>
              </Box>
              <Box
                sx={{
                  height: requestsVirtualizer.getTotalSize(),
                  minWidth: "100%",
                  position: "relative",
                }}
              >
                {requestsVirtualizer.getVirtualItems().map((virtualItem) => {
                  const req = rankedRequests[virtualItem.index];
                  if (!req) {
                    return null;
                  }

                  // The scroll container already draws the panel border, so the
                  // last row omits its divider to avoid a doubled bottom line.
                  const isLastRequestRow = virtualItem.index === rankedRequests.length - 1;

                  return (
                    <Box
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
                      style={{
                        height: virtualItem.size,
                        left: 0,
                        position: "absolute",
                        top: virtualItem.start,
                        width: "100%",
                      }}
                      sx={{
                        borderBottom: isLastRequestRow ? 0 : "1px solid",
                        borderColor: "divider",
                        cursor: "pointer",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <RequestRankingRow maxDuration={maxDuration} maxSize={maxSize} req={req} />
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
        )}
      </Paper>

      <HostContextMenu
        anchorPosition={ins.hostContextMenu?.anchorPosition}
        host={ins.hostContextMenu?.host ?? null}
        hostExact={ins.hostExact}
        selectedText={ins.hostContextMenu?.selectedText}
        onClose={ins.handleHostContextMenuClose}
        onCopyHost={ins.handleCopyHost}
        onExcludeHost={ins.handleExcludeHost}
        onFilterHost={ins.handleFilterHost}
        onFilterSelection={ins.handleFilterSelectedHostText}
        onOpenSessions={ins.handleOpenSessionsForHost}
      />

      <Snackbar
        autoHideDuration={2200}
        message={ins.snackbarMessage}
        onClose={() => ins.setSnackbarMessage(null)}
        open={Boolean(ins.snackbarMessage)}
      />
    </Stack>
  );
}
