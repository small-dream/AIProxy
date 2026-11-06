import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Alert, Box, Button, Chip, Divider, Paper, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

import type { SessionDiffPayload } from "@aiproxy/shared-types";

import {
  DIFF_SECTION_VISIBLE_CHANGE_LIMIT,
  LAZY_BODY_DIFF_SECTIONS,
} from "@/features/session-compare/use-session-compare";
import { useI18n, type TranslationKey } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

const SECTION_TITLE_KEYS: Record<string, TranslationKey> = {
  summary: "comparePage.diffText.sections.summary",
  query: "comparePage.diffText.sections.query",
  requestHeaders: "comparePage.diffText.sections.requestHeaders",
  requestBody: "comparePage.diffText.sections.requestBody",
  responseHeaders: "comparePage.diffText.sections.responseHeaders",
  responseBody: "comparePage.diffText.sections.responseBody",
  timing: "comparePage.diffText.sections.timing",
};

const SUMMARY_FIELD_KEYS: Record<string, TranslationKey> = {
  Method: "comparePage.diffText.fields.Method",
  URL: "comparePage.diffText.fields.URL",
  Status: "comparePage.diffText.fields.Status",
  Duration: "comparePage.diffText.fields.Duration",
  Size: "comparePage.diffText.fields.Size",
  Protocol: "comparePage.diffText.fields.Protocol",
  MIME: "comparePage.diffText.fields.MIME",
};

const TIMING_FIELD_KEYS: Record<string, TranslationKey> = {
  connectionWaitMs: "inspector.request.overview.fields.connectionWait",
  dnsMs: "inspector.request.overview.fields.dns",
  connectMs: "inspector.request.overview.fields.connect",
  tlsMs: "inspector.request.overview.fields.tlsHandshake",
  requestSendMs: "composePage.requestSend",
  waitingMs: "composePage.waiting",
  responseReadMs: "composePage.responseRead",
  totalMs: "composePage.timingTotal",
};

const BODY_METADATA_KEYS: Record<string, TranslationKey> = {
  "body.sizeBytes": "comparePage.diffText.metadata.sizeBytes",
  "body.mimeType": "comparePage.diffText.metadata.mimeType",
  "body.encoding": "comparePage.diffText.metadata.encoding",
  "body.text": "comparePage.diffText.metadata.text",
  "body.truncated": "comparePage.diffText.metadata.truncated",
};

export const KIND_KEYS = {
  added: "comparePage.diffText.kinds.added",
  removed: "comparePage.diffText.kinds.removed",
  changed: "comparePage.diffText.kinds.changed",
  unchanged: "comparePage.diffText.kinds.unchanged",
} as const satisfies Record<string, TranslationKey>;

export function DiffSectionCard({
  bodyDiffExpanded,
  displayExpanded,
  onToggleBodyDiff,
  onToggleDisplay,
  section,
}: {
  bodyDiffExpanded: boolean;
  displayExpanded: boolean;
  onToggleBodyDiff: () => void;
  onToggleDisplay: () => void;
  section: SessionDiffPayload["sections"][number];
}) {
  const { t } = useI18n();
  const fieldLabel = (path: string): string => {
    if (section.key === "summary") {
      const key = SUMMARY_FIELD_KEYS[path];
      return key ? t(key) : path;
    }
    if (section.key === "timing") {
      const key = TIMING_FIELD_KEYS[path];
      return key ? t(key) : path;
    }
    if (LAZY_BODY_DIFF_SECTIONS.has(section.key)) {
      const key = BODY_METADATA_KEYS[path];
      return key ? t(key) : path;
    }
    return path;
  };
  const isLazyBodySection = LAZY_BODY_DIFF_SECTIONS.has(section.key);
  const isCollapsedBodyMetadata = isLazyBodySection && !bodyDiffExpanded;
  const changedEntries = isCollapsedBodyMetadata
    ? section.entries
    : section.entries.filter((entry) => entry.kind !== "unchanged");
  const visibleEntries = displayExpanded
    ? changedEntries
    : changedEntries.slice(0, DIFF_SECTION_VISIBLE_CHANGE_LIMIT);
  const hasDisplayOverflow = changedEntries.length > DIFF_SECTION_VISIBLE_CHANGE_LIMIT;
  const canToggleBodyDiff = Boolean(
    isLazyBodySection && (section.canExpand || bodyDiffExpanded) && onToggleBodyDiff,
  );

  return (
    <Paper
      elevation={0}
      sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, overflow: "hidden" }}
    >
      <Stack
        direction={{ sm: "row", xs: "column" }}
        spacing={1}
        sx={[
          {
            alignItems: { sm: "center", xs: "flex-start" },
            justifyContent: "space-between",
          },
          (theme) => ({
            bgcolor: alpha(
              theme.palette.primary.main,
              theme.palette.mode === "dark" ? 0.12 : 0.045,
            ),
            borderBottom: 1,
            borderColor: "divider",
            px: 1.25,
            py: 1,
          }),
        ]}
      >
        <Typography variant="body2" sx={{ fontWeight: 750 }}>
          {SECTION_TITLE_KEYS[section.key] ? t(SECTION_TITLE_KEYS[section.key]!) : section.title}
        </Typography>
        <Stack
          direction="row"
          spacing={0.75}
          useFlexGap
          sx={{
            flexWrap: "wrap",
          }}
        >
          <Chip size="small" color="success" label={`+${section.added}`} variant="outlined" />
          <Chip size="small" color="error" label={`-${section.removed}`} variant="outlined" />
          <Chip size="small" color="warning" label={`~${section.changed}`} variant="outlined" />
          <Chip size="small" label={`=${section.unchanged}`} variant="outlined" />
        </Stack>
      </Stack>
      <Stack spacing={0} divider={<Divider />}>
        {section.note ? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              px: 1.25,
              py: 1,
            }}
          >
            {section.note}
          </Typography>
        ) : null}
        {section.truncated ? (
          <Alert severity="warning" sx={{ borderRadius: 0 }}>
            {section.truncationReason ?? t("comparePage.diffTruncated")}
          </Alert>
        ) : null}
        {canToggleBodyDiff ? (
          <Box sx={{ px: 1.25, py: 1 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={bodyDiffExpanded ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
              onClick={onToggleBodyDiff}
            >
              {bodyDiffExpanded
                ? t("comparePage.collapseBodyDiff")
                : t("comparePage.expandBodyDiff")}
            </Button>
          </Box>
        ) : null}
        {visibleEntries.length === 0 ? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              px: 1.25,
              py: 1,
            }}
          >
            {t("comparePage.noVisibleChanges")}
          </Typography>
        ) : (
          visibleEntries.map((entry) => (
            <Box
              key={`${entry.path}:${entry.kind}:${entry.before}:${entry.after}`}
              sx={{
                display: "grid",
                gap: 1,
                gridTemplateColumns: {
                  md: "minmax(160px, 0.35fr) minmax(0, 1fr) minmax(0, 1fr)",
                  xs: "1fr",
                },
                px: 1.25,
                py: 1,
              }}
            >
              <Stack
                direction="row"
                spacing={0.75}
                sx={{
                  alignItems: "center",
                  minWidth: 0,
                }}
              >
                <Chip size="small" label={t(KIND_KEYS[entry.kind])} />
                <Typography variant="body2" sx={{ fontFamily: fontFamilies.mono }} noWrap>
                  {fieldLabel(entry.path)}
                </Typography>
              </Stack>
              <DiffValue value={entry.before} />
              <DiffValue value={entry.after} />
            </Box>
          ))
        )}
        {hasDisplayOverflow ? (
          <Box sx={{ px: 1.25, py: 1 }}>
            <Button
              size="small"
              variant="text"
              startIcon={displayExpanded ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
              onClick={onToggleDisplay}
            >
              {displayExpanded
                ? t("comparePage.showFewerChanges")
                : t("comparePage.showAllChanges", { count: changedEntries.length })}
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}

export function DiffValue({ value }: { value: string | undefined }) {
  const { t } = useI18n();
  return (
    <Typography
      component="pre"
      sx={{
        bgcolor: "action.hover",
        borderRadius: 1,
        fontFamily: fontFamilies.mono,
        fontSize: 12,
        m: 0,
        minHeight: 30,
        overflowX: "auto",
        p: 0.75,
        whiteSpace: "pre-wrap",
      }}
    >
      {value || t("comparePage.diffText.empty")}
    </Typography>
  );
}
