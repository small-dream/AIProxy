import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { coerceAppError, type SessionDetail, type SessionDiffPayload, type SessionSummary } from "@aiproxy/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { useSessions } from "@/features/sessions/use-sessions";
import { buildSessionDiffPayload } from "@/features/session-compare/session-diff.helpers";
import { useI18n } from "@/i18n";
import { getAiSettings, summarizeSessionDiff } from "@/services/commands";
import { fontFamilies } from "@/themes/fonts";

type DetailState = {
  left?: SessionDetail;
  right?: SessionDetail;
  loading: boolean;
  error?: string | undefined;
};

const BODY_DIFF_DISPLAY_ENTRY_LIMIT = 240;
const DIFF_SECTION_VISIBLE_CHANGE_LIMIT = 120;
const LAZY_BODY_DIFF_SECTIONS = new Set(["requestBody", "responseBody"]);

export function ComparePage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions();
  const [leftId, setLeftId] = useState(searchParams.get("left") ?? "");
  const [rightId, setRightId] = useState(searchParams.get("right") ?? "");
  const [includeBodyForAi, setIncludeBodyForAi] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailState, setDetailState] = useState<DetailState>({ loading: false });
  const [expandedBodySections, setExpandedBodySections] = useState<Set<string>>(() => new Set());
  const [expandedEntrySections, setExpandedEntrySections] = useState<Set<string>>(() => new Set());
  const previousCompareKeyRef = useRef("");
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  });
  const summaryMutation = useMutation({
    mutationFn: (payload: SessionDiffPayload) =>
      summarizeSessionDiff({
        language: locale,
        payload,
      }),
  });

  useEffect(() => {
    const nextLeft = searchParams.get("left") ?? "";
    const nextRight = searchParams.get("right") ?? "";
    setLeftId(nextLeft);
    setRightId(nextRight);
  }, [searchParams]);

  useEffect(() => {
    if (!leftId || !rightId || leftId === rightId) {
      setDetailState({ loading: false });
      return;
    }

    let cancelled = false;
    setDetailState((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.all([
      ensureSessionDetailContent(queryClient, leftId, {
        includeRequestBodyText: true,
        includeResponseBodyText: true,
      }),
      ensureSessionDetailContent(queryClient, rightId, {
        includeRequestBodyText: true,
        includeResponseBodyText: true,
      }),
    ]).then(
      ([left, right]) => {
        if (!cancelled) {
          setDetailState({ left, right, loading: false });
        }
      },
      (error) => {
        if (!cancelled) {
          setDetailState({
            loading: false,
            error: coerceAppError(error).message || t("comparePage.detailLoadError"),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [leftId, queryClient, rightId, t]);

  useEffect(() => {
    const compareKey = `${leftId}:${rightId}:${includeBodyForAi}`;
    if (previousCompareKeyRef.current === compareKey) {
      return;
    }
    previousCompareKeyRef.current = compareKey;
    summaryMutation.reset();
    setExpandedBodySections(new Set());
    setExpandedEntrySections(new Set());
  }, [includeBodyForAi, leftId, rightId, summaryMutation]);

  const displayPayload = useMemo(() => {
    if (!detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "summary",
      expandedBodySections,
      includeBodyForAi,
      maxBodyEntries: BODY_DIFF_DISPLAY_ENTRY_LIMIT,
      redact: true,
    });
  }, [detailState.left, detailState.right, expandedBodySections, includeBodyForAi]);

  const buildAiPayload = () => {
    if (!detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "diff",
      includeBodyForAi,
      redact: true,
    });
  };

  const selectedLeft = useMemo(
    () => sessions.find((session) => session.id === leftId),
    [leftId, sessions],
  );
  const selectedRight = useMemo(
    () => sessions.find((session) => session.id === rightId),
    [rightId, sessions],
  );
  const aiSettings = aiSettingsQuery.data;
  const aiConfigured = Boolean(aiSettings?.hasApiKey && aiSettings.model.trim());

  function updateSelection(nextLeft: string, nextRight: string) {
    setLeftId(nextLeft);
    setRightId(nextRight);
    const params = new URLSearchParams(searchParams);
    if (nextLeft) params.set("left", nextLeft); else params.delete("left");
    if (nextRight) params.set("right", nextRight); else params.delete("right");
    setSearchParams(params);
  }

  const previewPayload = previewOpen ? buildAiPayload() : undefined;
  const previewText = previewPayload ? JSON.stringify(previewPayload, null, 2) : "";
  const canGenerate = Boolean(displayPayload && aiConfigured && !detailState.loading);

  function toggleBodySection(sectionKey: string) {
    setExpandedBodySections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }

  function toggleEntrySection(sectionKey: string) {
    setExpandedEntrySections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }

  return (
    <Stack spacing={1.5} sx={{ height: "100%", minHeight: 0 }}>
      <Stack
        direction={{ md: "row", xs: "column" }}
        spacing={1.25}
        alignItems={{ md: "center", xs: "stretch" }}
        justifyContent="space-between"
      >
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontSize: 28, lineHeight: 1.15 }}>
            {t("comparePage.title")}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {t("comparePage.description")}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            size="small"
            variant="outlined"
            startIcon={<VisibilityRoundedIcon />}
            onClick={() => setPreviewOpen(true)}
            disabled={!displayPayload}
          >
            {t("comparePage.previewPayload")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<AutoFixHighRoundedIcon />}
            onClick={() => {
              const aiPayload = buildAiPayload();
              if (aiPayload) {
                summaryMutation.mutate(aiPayload);
              }
            }}
            disabled={!canGenerate || summaryMutation.isPending}
          >
            {summaryMutation.isPending ? t("comparePage.generating") : t("comparePage.generateSummary")}
          </Button>
        </Stack>
      </Stack>

      <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5 }}>
        <Stack spacing={1.5}>
          <Box
            sx={{
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
            }}
          >
            <SessionSelect
              label={t("comparePage.leftSession")}
              loading={sessionsLoading}
              sessions={sessions}
              value={leftId}
              onChange={(value) => updateSelection(value, rightId)}
            />
            <SessionSelect
              label={t("comparePage.rightSession")}
              loading={sessionsLoading}
              sessions={sessions}
              value={rightId}
              onChange={(value) => updateSelection(leftId, value)}
            />
          </Box>

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              icon={<CompareArrowsRoundedIcon />}
              label={
                selectedLeft && selectedRight
                  ? `${selectedLeft.method} ${selectedLeft.host} -> ${selectedRight.method} ${selectedRight.host}`
                  : t("comparePage.pickTwoSessions")
              }
              variant="outlined"
            />
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={includeBodyForAi}
                  onChange={(event) => setIncludeBodyForAi(event.target.checked)}
                />
              }
              label={<Typography variant="body2">{t("comparePage.includeBody")}</Typography>}
            />
          </Stack>
        </Stack>
      </Paper>

      {leftId && rightId && leftId === rightId ? (
        <Alert severity="warning">{t("comparePage.sameSessionWarning")}</Alert>
      ) : null}
      {detailState.error ? <Alert severity="error">{detailState.error}</Alert> : null}

      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { lg: "minmax(0, 1fr) minmax(320px, 0.36fr)", xs: "1fr" },
          minHeight: 0,
          flex: 1,
        }}
      >
        <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, minHeight: 0, overflow: "hidden" }}>
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1 }}>
              <CompareArrowsRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
              <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>{t("comparePage.diffWorkbench")}</Typography>
              {detailState.loading ? <Chip size="small" label={t("comparePage.loadingDetails")} /> : null}
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
              {!displayPayload ? (
                <Alert severity="info">{t("comparePage.emptyState")}</Alert>
              ) : (
                <Stack spacing={1.25}>
                  {displayPayload.sections.map((section) => (
                    <DiffSectionCard
                      key={section.key}
                      bodyDiffExpanded={expandedBodySections.has(section.key)}
                      displayExpanded={expandedEntrySections.has(section.key)}
                      section={section}
                      onToggleBodyDiff={() => toggleBodySection(section.key)}
                      onToggleDisplay={() => toggleEntrySection(section.key)}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </Paper>

        <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden" }}>
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <AutoFixHighRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
                <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>{t("comparePage.aiSummary")}</Typography>
              </Stack>
              {aiSettings?.model ? <Chip size="small" label={aiSettings.model} variant="outlined" /> : null}
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
              {!aiConfigured ? (
                <Stack spacing={1.5}>
                  <Alert severity="info">{t("comparePage.aiNotConfigured")}</Alert>
                  <Button
                    variant="outlined"
                    startIcon={<SettingsRoundedIcon />}
                    onClick={() => navigate("/settings")}
                  >
                    {t("comparePage.configureAi")}
                  </Button>
                </Stack>
              ) : summaryMutation.error ? (
                <Alert severity="error">{coerceAppError(summaryMutation.error).message}</Alert>
              ) : summaryMutation.data ? (
                <Typography
                  component="pre"
                  sx={{
                    fontFamily: fontFamilies.mono,
                    fontSize: 13,
                    lineHeight: 1.7,
                    m: 0,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {summaryMutation.data.summary}
                </Typography>
              ) : (
                <Alert severity="info">{t("comparePage.summaryIdle")}</Alert>
              )}
            </Box>
          </Stack>
        </Paper>
      </Box>

      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{t("comparePage.previewPayload")}</DialogTitle>
        <DialogContent>
          <Typography
            component="pre"
            sx={{
              bgcolor: "background.default",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              fontFamily: fontFamilies.mono,
              fontSize: 12,
              maxHeight: 520,
              overflow: "auto",
              p: 1.25,
              whiteSpace: "pre-wrap",
            }}
          >
            {previewText || t("common.empty.noData")}
          </Typography>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

function SessionSelect({
  label,
  loading,
  onChange,
  sessions,
  value,
}: {
  label: string;
  loading: boolean;
  onChange: (value: string) => void;
  sessions: SessionSummary[];
  value: string;
}) {
  const { t } = useI18n();
  const hasSelectedSession = !value || sessions.some((session) => session.id === value);

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <MenuItem value="">
          {loading ? t("comparePage.loadingSessions") : t("comparePage.selectSession")}
        </MenuItem>
        {value && !hasSelectedSession ? (
          <MenuItem value={value}>
            {loading ? t("comparePage.loadingSessions") : t("comparePage.missingSession")}
          </MenuItem>
        ) : null}
        {sessions.map((session) => (
          <MenuItem key={session.id} value={session.id}>
            {`${session.method} ${session.host}${session.path} - ${session.statusCode} - ${session.startedAt}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function DiffSectionCard({
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
  const canToggleBodyDiff = Boolean(isLazyBodySection && (section.canExpand || bodyDiffExpanded) && onToggleBodyDiff);

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, overflow: "hidden" }}>
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
        <Typography variant="body2" sx={{ fontWeight: 750 }}>{section.title}</Typography>
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
              {bodyDiffExpanded ? t("comparePage.collapseBodyDiff") : t("comparePage.expandBodyDiff")}
            </Button>
          </Box>
        ) : null}
        {visibleEntries.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ px: 1.25, py: 1 }}>
            {t("comparePage.noVisibleChanges")}
          </Typography>
        ) : visibleEntries.map((entry) => (
          <Box
            key={`${entry.path}:${entry.kind}:${entry.before}:${entry.after}`}
            sx={{
              display: "grid",
              gap: 1,
              gridTemplateColumns: { md: "minmax(160px, 0.35fr) minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
              px: 1.25,
              py: 1,
            }}
          >
            <Stack direction="row" spacing={0.75} alignItems="center" minWidth={0}>
              <Chip size="small" label={entry.kind} />
              <Typography variant="body2" sx={{ fontFamily: fontFamilies.mono }} noWrap>{entry.path}</Typography>
            </Stack>
            <DiffValue value={entry.before} />
            <DiffValue value={entry.after} />
          </Box>
        ))}
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

function DiffValue({ value }: { value: string | undefined }) {
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
