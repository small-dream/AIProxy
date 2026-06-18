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
  Typography,
  darken,
} from "@mui/material";
import { useNavigate } from "react-router-dom";

import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  getDurationIntensity,
  normalizeHostValue,
  summarizeUrl,
} from "@/features/insights/compute-insights.helpers";
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
// Main page
// ---------------------------------------------------------------------------

export function InsightsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const ins = useInsightsData();

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
          <Stack direction="row" spacing={1.1} sx={{ flexWrap: "wrap", mb: 2.25 }}>
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

        {!ins.filteredOutAllData && ins.data.byHost.length > 0 && (
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
        )}

        {!ins.filteredOutAllData && (
          <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", mb: 2.25 }}>
            {ins.data.byStatusCode.length > 0 && (
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

            {ins.data.byMethod.length > 0 && (
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

        {!ins.filteredOutAllData && ins.data.slowRequests.length > 0 && (
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
                {ins.data.slowRequests.map((req) => {
                  const urlSummary = summarizeUrl(req.url);
                  const durationIntensity = getDurationIntensity(
                    req.durationMs,
                    ins.slowRequestMaxDuration,
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
