import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";

import type { SessionDiffPayload } from "@aiproxy/shared-types";

import {
  DIFF_SECTION_VISIBLE_CHANGE_LIMIT,
  LAZY_BODY_DIFF_SECTIONS,
} from "@/features/session-compare/use-session-compare";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

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
        alignItems={{ sm: "center", xs: "flex-start" }}
        justifyContent="space-between"
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.045),
          borderBottom: 1,
          borderColor: "divider",
          px: 1.25,
          py: 1,
        })}
      >
        <Typography variant="body2" sx={{ fontWeight: 750 }}>
          {section.title}
        </Typography>
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          <Chip size="small" color="success" label={`+${section.added}`} variant="outlined" />
          <Chip size="small" color="error" label={`-${section.removed}`} variant="outlined" />
          <Chip size="small" color="warning" label={`~${section.changed}`} variant="outlined" />
          <Chip size="small" label={`=${section.unchanged}`} variant="outlined" />
        </Stack>
      </Stack>
      <Stack spacing={0} divider={<Divider />}>
        {section.note ? (
          <Typography color="text.secondary" variant="body2" sx={{ px: 1.25, py: 1 }}>
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
          <Typography color="text.secondary" variant="body2" sx={{ px: 1.25, py: 1 }}>
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
              <Stack direction="row" spacing={0.75} alignItems="center" minWidth={0}>
                <Chip size="small" label={entry.kind} />
                <Typography variant="body2" sx={{ fontFamily: fontFamilies.mono }} noWrap>
                  {entry.path}
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
      {value || "(empty)"}
    </Typography>
  );
}
