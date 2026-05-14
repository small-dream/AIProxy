import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
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
  }, [includeBodyForAi, leftId, rightId, summaryMutation]);

  const payload = useMemo(() => {
    if (!detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      includeBodyForAi,
      redact: true,
    });
  }, [detailState.left, detailState.right, includeBodyForAi]);

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

  const previewText = payload ? JSON.stringify(payload, null, 2) : "";
  const canGenerate = Boolean(payload && aiConfigured && !detailState.loading);

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
            disabled={!payload}
          >
            {t("comparePage.previewPayload")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<AutoFixHighRoundedIcon />}
            onClick={() => payload && summaryMutation.mutate(payload)}
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
              {!payload ? (
                <Alert severity="info">{t("comparePage.emptyState")}</Alert>
              ) : (
                <Stack spacing={1.25}>
                  {payload.sections.map((section) => (
                    <DiffSectionCard key={section.key} section={section} />
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

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <MenuItem value="">
          {loading ? t("comparePage.loadingSessions") : t("comparePage.selectSession")}
        </MenuItem>
        {sessions.map((session) => (
          <MenuItem key={session.id} value={session.id}>
            {`${session.method} ${session.host}${session.path} - ${session.statusCode} - ${session.startedAt}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function DiffSectionCard({ section }: { section: SessionDiffPayload["sections"][number] }) {
  const { t } = useI18n();
  const visibleEntries = section.entries.filter((entry) => entry.kind !== "unchanged").slice(0, 120);

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
