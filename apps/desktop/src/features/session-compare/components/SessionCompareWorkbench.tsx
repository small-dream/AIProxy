import {
  Alert,
  Box,
  Chip,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

import type { SessionComparePayload } from "@aiproxy/shared-types";

import { SEQUENCE_PREVIEW_LIMIT, SESSION_TABLE_LIMIT } from "@/features/session-compare/use-session-compare";
import { useI18n, type TranslationKey, type TranslationParams } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function SessionCompareWorkbench({
  hasScopes,
  payload,
}: {
  hasScopes: boolean;
  payload?: SessionComparePayload | undefined;
}) {
  const { t } = useI18n();

  if (!hasScopes) {
    return <Alert severity="info">{t("comparePage.noSessionScopes")}</Alert>;
  }

  if (!payload) {
    return <Alert severity="info">{t("comparePage.sessionEmptyState")}</Alert>;
  }

  return (
    <Stack spacing={1.25}>
      <BehaviorSection title={t("comparePage.overview")}>
        <MetricGrid
          t={t}
          rows={[
            [t("comparePage.metrics.requests"), payload.overview.left.requestCount, payload.overview.right.requestCount],
            [t("comparePage.metrics.success"), payload.overview.left.successCount, payload.overview.right.successCount],
            [t("comparePage.metrics.failures"), payload.overview.left.failureCount, payload.overview.right.failureCount],
            [t("comparePage.domains"), payload.overview.left.domainCount, payload.overview.right.domainCount],
            [
              t("comparePage.avgDuration"),
              `${payload.overview.left.durationMs.average} ms`,
              `${payload.overview.right.durationMs.average} ms`,
            ],
            [
              t("comparePage.totalBytes"),
              formatNumber(payload.overview.left.totalSizeBytes),
              formatNumber(payload.overview.right.totalSizeBytes),
            ],
            [
              t("comparePage.metrics.statusCodes"),
              formatStatusCodes(payload.overview.left.statusCodes),
              formatStatusCodes(payload.overview.right.statusCodes),
            ],
          ]}
        />
      </BehaviorSection>

      <BehaviorSection title={t("comparePage.domains")}>
        <CompareRows
          columns={[
            t("comparePage.domain"),
            t("comparePage.leftCount"),
            t("comparePage.rightCount"),
            t("comparePage.delta"),
            t("comparePage.share"),
          ]}
          rows={payload.domains.map((row) => [
            row.domain,
            String(row.leftCount),
            String(row.rightCount),
            formatDelta(row.delta),
            `${row.leftShare}% -> ${row.rightShare}%`,
          ])}
        />
      </BehaviorSection>

      <BehaviorSection title={t("comparePage.endpoints")}>
        <CompareRows
          columns={[
            t("comparePage.endpoint"),
            t("comparePage.kind"),
            t("comparePage.leftCount"),
            t("comparePage.rightCount"),
            t("comparePage.avgDuration"),
          ]}
          rows={payload.endpoints
            .slice(0, SESSION_TABLE_LIMIT)
            .map((row) => [
              row.endpoint,
              row.kind,
              String(row.leftCount),
              String(row.rightCount),
              `${row.leftAverageDurationMs} ms -> ${row.rightAverageDurationMs} ms`,
            ])}
        />
      </BehaviorSection>

      <BehaviorSection title={t("comparePage.timeline")}>
        <CompareRows
          columns={[
            t("comparePage.bucket"),
            t("comparePage.leftCount"),
            t("comparePage.rightCount"),
            t("comparePage.delta"),
          ]}
          rows={payload.timeline.buckets.map((bucket) => [
            formatTime(bucket.startedAt),
            String(bucket.leftCount),
            String(bucket.rightCount),
            formatDelta(bucket.delta),
          ])}
        />
      </BehaviorSection>

      <BehaviorSection title={t("comparePage.sequence")}>
        <Stack spacing={1}>
          <SequenceSummary payload={payload} />
          <CompareRows
            columns={[
              t("comparePage.index"),
              t("comparePage.leftEndpoint"),
              t("comparePage.rightEndpoint"),
            ]}
            rows={payload.sequence.changedPositions
              .slice(0, SESSION_TABLE_LIMIT)
              .map((row) => [String(row.index + 1), row.left ?? "", row.right ?? ""])}
          />
        </Stack>
      </BehaviorSection>
    </Stack>
  );
}

function SequenceSummary({ payload }: { payload: SessionComparePayload }) {
  const { t } = useI18n();
  const added = payload.sequence.addedEndpoints.slice(0, SEQUENCE_PREVIEW_LIMIT);
  const removed = payload.sequence.removedEndpoints.slice(0, SEQUENCE_PREVIEW_LIMIT);
  const repeated = payload.sequence.repeatedEndpoints.slice(0, SEQUENCE_PREVIEW_LIMIT);

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{
        flexWrap: "wrap"
      }}>
        <Chip
          size="small"
          color="success"
          label={`${t("comparePage.addedEndpoints")}: ${payload.sequence.addedEndpoints.length}`}
          variant="outlined"
        />
        <Chip
          size="small"
          color="error"
          label={`${t("comparePage.removedEndpoints")}: ${payload.sequence.removedEndpoints.length}`}
          variant="outlined"
        />
        <Chip
          size="small"
          color="warning"
          label={`${t("comparePage.orderChanges")}: ${payload.sequence.changedPositions.length}`}
          variant="outlined"
        />
        <Chip
          size="small"
          label={`${t("comparePage.repeatedEndpoints")}: ${payload.sequence.repeatedEndpoints.length}`}
          variant="outlined"
        />
      </Stack>
      <EndpointList title={t("comparePage.addedEndpoints")} endpoints={added} />
      <EndpointList title={t("comparePage.removedEndpoints")} endpoints={removed} />
      <EndpointList
        title={t("comparePage.repeatedEndpoints")}
        endpoints={repeated.map((row) => `${row.endpoint} (${row.leftCount} -> ${row.rightCount})`)}
      />
    </Stack>
  );
}

function EndpointList({ endpoints, title }: { endpoints: string[]; title: string }) {
  if (endpoints.length === 0) {
    return null;
  }

  return (
    <Stack spacing={0.5}>
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Stack spacing={0.5}>
        {endpoints.map((endpoint) => (
          <Typography
            key={endpoint}
            component="code"
            sx={{ fontFamily: fontFamilies.mono, fontSize: 12, overflowWrap: "anywhere" }}
          >
            {endpoint}
          </Typography>
        ))}
      </Stack>
    </Stack>
  );
}

function BehaviorSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <Paper
      elevation={0}
      sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, overflow: "hidden" }}
    >
      <Typography
        variant="body2"
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.045),
          borderBottom: 1,
          borderColor: "divider",
          fontWeight: 750,
          px: 1.25,
          py: 1,
        })}
      >
        {title}
      </Typography>
      <Box sx={{ p: 1.25 }}>{children}</Box>
    </Paper>
  );
}

function MetricGrid({ rows, t }: { rows: Array<[string, string | number, string | number]>; t: (key: TranslationKey, params?: TranslationParams) => string }) {
  return (
    <Box
      sx={{
        display: "grid",
        gap: 0.75,
        gridTemplateColumns: { md: "180px minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
      }}
    >
      <Typography variant="caption" sx={{
        color: "text.secondary"
      }}>
        {t("comparePage.metricGrid.metric")}
      </Typography>
      <Typography variant="caption" sx={{
        color: "text.secondary"
      }}>
        {t("comparePage.metricGrid.left")}
      </Typography>
      <Typography variant="caption" sx={{
        color: "text.secondary"
      }}>
        {t("comparePage.metricGrid.right")}
      </Typography>
      {rows.map(([label, left, right]) => (
        <Box key={label} sx={{ display: "contents" }}>
          <Typography variant="body2" sx={{ fontWeight: 650 }}>
            {label}
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {left}
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {right}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function CompareRows({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const { t } = useI18n();

  if (rows.length === 0) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>
        {t("comparePage.noVisibleChanges")}
      </Typography>
    );
  }

  return (
    <Stack spacing={0} divider={<Divider />}>
      <Box
        sx={{
          display: "grid",
          gap: 1,
          gridTemplateColumns: `minmax(180px, 1.5fr) repeat(${columns.length - 1}, minmax(92px, 0.65fr))`,
          px: 0.75,
          py: 0.5,
        }}
      >
        {columns.map((column) => (
          <Typography
            key={column}
            variant="caption"
            sx={{
              color: "text.secondary",
              fontWeight: 700
            }}>
            {column}
          </Typography>
        ))}
      </Box>
      {rows.map((row, index) => (
        <Box
          key={`${row.join(":")}:${index}`}
          sx={{
            display: "grid",
            gap: 1,
            gridTemplateColumns: `minmax(180px, 1.5fr) repeat(${columns.length - 1}, minmax(92px, 0.65fr))`,
            px: 0.75,
            py: 0.75,
          }}
        >
          {row.map((cell, cellIndex) => (
            <Typography
              key={`${cell}:${cellIndex}`}
              variant="body2"
              sx={{
                fontFamily: cellIndex === 0 ? fontFamilies.mono : undefined,
                fontSize: cellIndex === 0 ? 12 : undefined,
                overflowWrap: "anywhere",
              }}
            >
              {cell || "(empty)"}
            </Typography>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

// --- Format helpers ---

function formatDelta(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatStatusCodes(statusCodes: Record<string, number>) {
  const entries = Object.entries(statusCodes).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0
    ? entries.map(([status, count]) => `${status}:${count}`).join(", ")
    : "(none)";
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : value;
}
