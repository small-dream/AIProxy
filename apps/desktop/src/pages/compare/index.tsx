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
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ReactMarkdown from "react-markdown";
import {
  coerceAppError,
  type CompareAiPayload,
  type CompareMode,
  type SessionComparePayload,
  type SessionDetail,
  type SessionDiffPayload,
  type SessionSummary,
} from "@aiproxy/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  buildSessionComparePayload,
  getAvailableDomains,
  type SessionCompareScopeInput,
} from "@/features/session-compare/session-behavior-diff.helpers";
import { buildSessionDiffPayload } from "@/features/session-compare/session-diff.helpers";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import {
  type SessionCompareScope,
  useSessionCompareScopes,
} from "@/features/sessions/session-scope-registry";
import { useSessions } from "@/features/sessions/use-sessions";
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
const SESSION_TABLE_LIMIT = 80;
const SEQUENCE_PREVIEW_LIMIT = 36;

export function ComparePage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { data: sessions = [], isLoading: sessionsLoading } = useSessions();
  const scopes = useSessionCompareScopes();
  const [compareMode, setCompareMode] = useState<CompareMode>(readCompareMode(searchParams));
  const [leftId, setLeftId] = useState(searchParams.get("left") ?? "");
  const [rightId, setRightId] = useState(searchParams.get("right") ?? "");
  const [leftScopeId, setLeftScopeId] = useState(searchParams.get("leftScope") ?? "");
  const [rightScopeId, setRightScopeId] = useState(searchParams.get("rightScope") ?? "");
  const [domainFilter, setDomainFilter] = useState<string[]>(readDomains(searchParams));
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
    mutationFn: (payload: CompareAiPayload) =>
      summarizeSessionDiff({
        language: locale,
        payload,
      }),
  });

  useEffect(() => {
    setCompareMode(readCompareMode(searchParams));
    setLeftId(searchParams.get("left") ?? "");
    setRightId(searchParams.get("right") ?? "");
    setLeftScopeId(searchParams.get("leftScope") ?? "");
    setRightScopeId(searchParams.get("rightScope") ?? "");
    setDomainFilter(readDomains(searchParams));
  }, [searchParams]);

  useEffect(() => {
    if (compareMode !== "request" || !leftId || !rightId || leftId === rightId) {
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
  }, [compareMode, leftId, queryClient, rightId, t]);

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const scopeOptions = useMemo(
    () => scopes.map((scope) => resolveScope(scope, sessionById)),
    [scopes, sessionById],
  );
  const selectedLeft = useMemo(
    () => sessions.find((session) => session.id === leftId),
    [leftId, sessions],
  );
  const selectedRight = useMemo(
    () => sessions.find((session) => session.id === rightId),
    [rightId, sessions],
  );
  const selectedLeftScope = useMemo(
    () => scopeOptions.find((scope) => scope.id === leftScopeId),
    [leftScopeId, scopeOptions],
  );
  const selectedRightScope = useMemo(
    () => scopeOptions.find((scope) => scope.id === rightScopeId),
    [rightScopeId, scopeOptions],
  );
  const domainOptions = useMemo(
    () =>
      getAvailableDomains(selectedLeftScope?.sessions ?? [], selectedRightScope?.sessions ?? []),
    [selectedLeftScope?.sessions, selectedRightScope?.sessions],
  );
  const effectiveDomainFilter = useMemo(
    () => domainFilter.filter((domain) => domainOptions.includes(domain)),
    [domainFilter, domainOptions],
  );

  useEffect(() => {
    const compareKey = `${compareMode}:${leftId}:${rightId}:${leftScopeId}:${rightScopeId}:${effectiveDomainFilter.join(",")}:${includeBodyForAi}`;
    if (previousCompareKeyRef.current === compareKey) {
      return;
    }
    previousCompareKeyRef.current = compareKey;
    summaryMutation.reset();
    setExpandedBodySections(new Set());
    setExpandedEntrySections(new Set());
  }, [
    compareMode,
    effectiveDomainFilter,
    includeBodyForAi,
    leftId,
    leftScopeId,
    rightId,
    rightScopeId,
    summaryMutation,
  ]);

  const requestDisplayPayload = useMemo(() => {
    if (compareMode !== "request" || !detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "summary",
      expandedBodySections,
      includeBodyForAi,
      maxBodyEntries: BODY_DIFF_DISPLAY_ENTRY_LIMIT,
      redact: true,
    });
  }, [compareMode, detailState.left, detailState.right, expandedBodySections, includeBodyForAi]);

  const sessionPayload = useMemo(() => {
    if (
      compareMode !== "session" ||
      !selectedLeftScope ||
      !selectedRightScope ||
      selectedLeftScope.id === selectedRightScope.id
    ) {
      return undefined;
    }
    return buildSessionComparePayload(selectedLeftScope, selectedRightScope, effectiveDomainFilter);
  }, [compareMode, effectiveDomainFilter, selectedLeftScope, selectedRightScope]);

  const displayPayload = compareMode === "request" ? requestDisplayPayload : sessionPayload;
  const aiSettings = aiSettingsQuery.data;
  const aiConfigured = Boolean(aiSettings?.hasApiKey && aiSettings.model.trim());
  const canGenerate = Boolean(displayPayload && aiConfigured && !detailState.loading);
  const previewPayload = previewOpen ? buildAiPayload() : undefined;
  const previewText = previewPayload ? JSON.stringify(previewPayload, null, 2) : "";

  function buildAiPayload(): CompareAiPayload | undefined {
    if (compareMode === "session") {
      return sessionPayload;
    }
    if (!detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "diff",
      includeBodyForAi,
      redact: true,
    });
  }

  function updateMode(nextMode: CompareMode) {
    setCompareMode(nextMode);
    const params = new URLSearchParams(searchParams);
    params.set("mode", nextMode);
    setSearchParams(params);
  }

  function updateRequestSelection(nextLeft: string, nextRight: string) {
    setLeftId(nextLeft);
    setRightId(nextRight);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "request");
    if (nextLeft) params.set("left", nextLeft);
    else params.delete("left");
    if (nextRight) params.set("right", nextRight);
    else params.delete("right");
    setSearchParams(params);
  }

  function updateScopeSelection(nextLeftScope: string, nextRightScope: string) {
    setLeftScopeId(nextLeftScope);
    setRightScopeId(nextRightScope);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "session");
    if (nextLeftScope) params.set("leftScope", nextLeftScope);
    else params.delete("leftScope");
    if (nextRightScope) params.set("rightScope", nextRightScope);
    else params.delete("rightScope");
    setSearchParams(params);
  }

  function updateDomainFilter(nextDomains: string[]) {
    const normalizedDomains = nextDomains.filter((domain) => domainOptions.includes(domain));
    setDomainFilter(normalizedDomains);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "session");
    if (normalizedDomains.length > 0) {
      params.set("domains", normalizedDomains.join(","));
    } else {
      params.delete("domains");
    }
    setSearchParams(params);
  }

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

  const isSameSelection =
    compareMode === "request"
      ? Boolean(leftId && rightId && leftId === rightId)
      : Boolean(leftScopeId && rightScopeId && leftScopeId === rightScopeId);

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
            {compareMode === "request"
              ? t("comparePage.requestDescription")
              : t("comparePage.sessionDescription")}
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
            {summaryMutation.isPending
              ? t("comparePage.generating")
              : t("comparePage.generateSummary")}
          </Button>
        </Stack>
      </Stack>

      <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5 }}>
        <Stack spacing={1.5}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={compareMode}
            onChange={(_, value: CompareMode | null) => {
              if (value) {
                updateMode(value);
              }
            }}
          >
            <ToggleButton value="request">{t("comparePage.requestCompare")}</ToggleButton>
            <ToggleButton value="session">{t("comparePage.sessionCompare")}</ToggleButton>
          </ToggleButtonGroup>

          {compareMode === "request" ? (
            <RequestCompareControls
              includeBodyForAi={includeBodyForAi}
              leftId={leftId}
              loading={sessionsLoading}
              rightId={rightId}
              selectedLeft={selectedLeft}
              selectedRight={selectedRight}
              sessions={sessions}
              onIncludeBodyForAiChange={setIncludeBodyForAi}
              onSelectionChange={updateRequestSelection}
            />
          ) : (
            <SessionCompareControls
              domainFilter={effectiveDomainFilter}
              domainOptions={domainOptions}
              leftScopeId={leftScopeId}
              rightScopeId={rightScopeId}
              scopes={scopeOptions}
              onDomainFilterChange={updateDomainFilter}
              onSelectionChange={updateScopeSelection}
            />
          )}
        </Stack>
      </Paper>

      {isSameSelection ? (
        <Alert severity="warning">{t("comparePage.sameSessionWarning")}</Alert>
      ) : null}
      {compareMode === "request" && detailState.error ? (
        <Alert severity="error">{detailState.error}</Alert>
      ) : null}

      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { lg: "minmax(0, 1fr) minmax(320px, 0.36fr)", xs: "1fr" },
          minHeight: 0,
          flex: 1,
        }}
      >
        <Paper
          elevation={0}
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1 }}
            >
              <CompareArrowsRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
              <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
                {compareMode === "request"
                  ? t("comparePage.diffWorkbench")
                  : t("comparePage.behaviorWorkbench")}
              </Typography>
              {compareMode === "request" && detailState.loading ? (
                <Chip size="small" label={t("comparePage.loadingDetails")} />
              ) : null}
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
              {compareMode === "request" ? (
                !requestDisplayPayload ? (
                  <Alert severity="info">{t("comparePage.requestEmptyState")}</Alert>
                ) : (
                  <Stack spacing={1.25}>
                    {requestDisplayPayload.sections.map((section) => (
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
                )
              ) : (
                <SessionCompareWorkbench
                  hasScopes={scopeOptions.length > 0}
                  payload={sessionPayload}
                />
              )}
            </Box>
          </Stack>
        </Paper>

        <AiSummaryPanel
          aiConfigured={aiConfigured}
          model={aiSettings?.model}
          mutationData={summaryMutation.data?.summary}
          mutationError={summaryMutation.error}
          onConfigure={() => navigate("/settings")}
        />
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

function RequestCompareControls({
  includeBodyForAi,
  leftId,
  loading,
  onIncludeBodyForAiChange,
  onSelectionChange,
  rightId,
  selectedLeft,
  selectedRight,
  sessions,
}: {
  includeBodyForAi: boolean;
  leftId: string;
  loading: boolean;
  onIncludeBodyForAiChange: (value: boolean) => void;
  onSelectionChange: (left: string, right: string) => void;
  rightId: string;
  selectedLeft?: SessionSummary | undefined;
  selectedRight?: SessionSummary | undefined;
  sessions: SessionSummary[];
}) {
  const { t } = useI18n();

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
        }}
      >
        <RequestSelect
          label={t("comparePage.leftRequest")}
          loading={loading}
          sessions={sessions}
          value={leftId}
          onChange={(value) => onSelectionChange(value, rightId)}
        />
        <RequestSelect
          label={t("comparePage.rightRequest")}
          loading={loading}
          sessions={sessions}
          value={rightId}
          onChange={(value) => onSelectionChange(leftId, value)}
        />
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip
          icon={<CompareArrowsRoundedIcon />}
          label={
            selectedLeft && selectedRight
              ? `${selectedLeft.method} ${selectedLeft.host} -> ${selectedRight.method} ${selectedRight.host}`
              : t("comparePage.pickTwoRequests")
          }
          variant="outlined"
        />
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={includeBodyForAi}
              onChange={(event) => onIncludeBodyForAiChange(event.target.checked)}
            />
          }
          label={<Typography variant="body2">{t("comparePage.includeBody")}</Typography>}
        />
      </Stack>
    </Stack>
  );
}

function SessionCompareControls({
  domainFilter,
  domainOptions,
  leftScopeId,
  onDomainFilterChange,
  onSelectionChange,
  rightScopeId,
  scopes,
}: {
  domainFilter: string[];
  domainOptions: string[];
  leftScopeId: string;
  onDomainFilterChange: (domains: string[]) => void;
  onSelectionChange: (leftScope: string, rightScope: string) => void;
  rightScopeId: string;
  scopes: SessionCompareScopeInput[];
}) {
  const { t } = useI18n();

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
        }}
      >
        <ScopeSelect
          label={t("comparePage.leftSessionScope")}
          scopes={scopes}
          value={leftScopeId}
          onChange={(value) => onSelectionChange(value, rightScopeId)}
        />
        <ScopeSelect
          label={t("comparePage.rightSessionScope")}
          scopes={scopes}
          value={rightScopeId}
          onChange={(value) => onSelectionChange(leftScopeId, value)}
        />
      </Box>
      <FormControl
        size="small"
        fullWidth
        disabled={!leftScopeId || !rightScopeId || domainOptions.length === 0}
      >
        <InputLabel>{t("comparePage.domainFilter")}</InputLabel>
        <Select
          multiple
          label={t("comparePage.domainFilter")}
          value={domainFilter}
          renderValue={(selected) =>
            selected.length === 0 ? t("comparePage.allDomains") : selected.join(", ")
          }
          onChange={(event) => {
            const value = event.target.value;
            onDomainFilterChange(typeof value === "string" ? value.split(",") : value);
          }}
        >
          {domainOptions.map((domain) => (
            <MenuItem key={domain} value={domain}>
              <Checkbox checked={domainFilter.includes(domain)} />
              <ListItemText primary={domain} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Chip
        icon={<CompareArrowsRoundedIcon />}
        label={
          leftScopeId && rightScopeId
            ? t("comparePage.sessionBehaviorReady")
            : t("comparePage.pickTwoSessionScopes")
        }
        variant="outlined"
      />
    </Stack>
  );
}

function RequestSelect({
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
          {loading ? t("comparePage.loadingSessions") : t("comparePage.selectRequest")}
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

function ScopeSelect({
  label,
  onChange,
  scopes,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  scopes: SessionCompareScopeInput[];
  value: string;
}) {
  const { t } = useI18n();
  const hasSelectedScope = !value || scopes.some((scope) => scope.id === value);

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select
        label={label}
        value={hasSelectedScope ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <MenuItem value="">{t("comparePage.selectSessionScope")}</MenuItem>
        {scopes.map((scope) => (
          <MenuItem key={scope.id} value={scope.id}>
            {`${scope.label} - ${t("comparePage.requestCount", { count: scope.sessions.length })}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function SessionCompareWorkbench({
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
          rows={[
            ["Requests", payload.overview.left.requestCount, payload.overview.right.requestCount],
            ["Success", payload.overview.left.successCount, payload.overview.right.successCount],
            ["Failures", payload.overview.left.failureCount, payload.overview.right.failureCount],
            ["Domains", payload.overview.left.domainCount, payload.overview.right.domainCount],
            [
              "Avg duration",
              `${payload.overview.left.durationMs.average} ms`,
              `${payload.overview.right.durationMs.average} ms`,
            ],
            [
              "Total bytes",
              formatNumber(payload.overview.left.totalSizeBytes),
              formatNumber(payload.overview.right.totalSizeBytes),
            ],
            [
              "Status codes",
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
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
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

function MetricGrid({ rows }: { rows: Array<[string, string | number, string | number]> }) {
  return (
    <Box
      sx={{
        display: "grid",
        gap: 0.75,
        gridTemplateColumns: { md: "180px minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
      }}
    >
      <Typography color="text.secondary" variant="caption">
        Metric
      </Typography>
      <Typography color="text.secondary" variant="caption">
        Left
      </Typography>
      <Typography color="text.secondary" variant="caption">
        Right
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
      <Typography color="text.secondary" variant="body2">
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
            color="text.secondary"
            variant="caption"
            sx={{ fontWeight: 700 }}
          >
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

function AiSummaryPanel({
  aiConfigured,
  model,
  mutationData,
  mutationError,
  onConfigure,
}: {
  aiConfigured: boolean;
  model?: string | undefined;
  mutationData?: string | undefined;
  mutationError: unknown;
  onConfigure: () => void;
}) {
  const { t } = useI18n();

  return (
    <Paper
      elevation={0}
      sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden" }}
    >
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <AutoFixHighRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
            <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
              {t("comparePage.aiSummary")}
            </Typography>
          </Stack>
          {model ? <Chip size="small" label={model} variant="outlined" /> : null}
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {!aiConfigured ? (
            <Stack spacing={1.5}>
              <Alert severity="info">{t("comparePage.aiNotConfigured")}</Alert>
              <Button variant="outlined" startIcon={<SettingsRoundedIcon />} onClick={onConfigure}>
                {t("comparePage.configureAi")}
              </Button>
            </Stack>
          ) : mutationError ? (
            <Alert severity="error">{coerceAppError(mutationError).message}</Alert>
          ) : mutationData ? (
            <ReactMarkdown components={markdownComponents}>{mutationData}</ReactMarkdown>
          ) : (
            <Alert severity="info">{t("comparePage.summaryIdle")}</Alert>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <Typography component="h1" sx={{ fontSize: 18, fontWeight: 750, mt: 1.5, mb: 0.75 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography component="h2" sx={{ fontSize: 16, fontWeight: 750, mt: 1.5, mb: 0.75 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography component="h3" sx={{ fontSize: 14, fontWeight: 750, mt: 1.25, mb: 0.5 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography component="p" sx={{ fontSize: 13, lineHeight: 1.7, mb: 1 }}>
      {children}
    </Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ fontWeight: 700 }}>
      {children}
    </Box>
  ),
  em: ({ children }) => (
    <Box component="em" sx={{ fontStyle: "italic" }}>
      {children}
    </Box>
  ),
  code: ({ children }) => (
    <Box
      component="code"
      sx={{
        fontFamily: fontFamilies.mono,
        fontSize: 12,
        bgcolor: "action.hover",
        borderRadius: 0.5,
        px: 0.5,
        py: 0.25,
      }}
    >
      {children}
    </Box>
  ),
  pre: ({ children }) => (
    <Box
      component="pre"
      sx={{
        fontFamily: fontFamilies.mono,
        fontSize: 12,
        bgcolor: "action.hover",
        borderRadius: 1,
        p: 1,
        overflowX: "auto",
        mb: 1,
      }}
    >
      {children}
    </Box>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ pl: 2.5, mb: 1, fontSize: 13, lineHeight: 1.7 }}>
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box component="ol" sx={{ pl: 2.5, mb: 1, fontSize: 13, lineHeight: 1.7 }}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Box component="li" sx={{ mb: 0.25 }}>
      {children}
    </Box>
  ),
  a: ({ children, href }) => (
    <Typography
      component="a"
      href={href}
      sx={{ fontSize: 13, color: "primary.main", textDecoration: "underline" }}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </Typography>
  ),
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        borderLeft: 2,
        borderColor: "divider",
        pl: 1.5,
        my: 1,
        color: "text.secondary",
        fontSize: 13,
      }}
    >
      {children}
    </Box>
  ),
  hr: () => <Divider sx={{ my: 1.5 }} />,
  table: ({ children }) => (
    <TableContainer component={Box} sx={{ mb: 1 }}>
      <Table size="small">{children}</Table>
    </TableContainer>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>{children}</TableCell>,
  td: ({ children }) => <TableCell sx={{ fontSize: 12 }}>{children}</TableCell>,
};

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

function resolveScope(
  scope: SessionCompareScope,
  sessionById: Map<string, SessionSummary>,
): SessionCompareScopeInput {
  return {
    id: scope.id,
    label: scope.label,
    sessions: scope.sessionIds
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session): session is SessionSummary => Boolean(session)),
  };
}

function readCompareMode(searchParams: URLSearchParams): CompareMode {
  return searchParams.get("mode") === "session" ? "session" : "request";
}

function readDomains(searchParams: URLSearchParams) {
  return (searchParams.get("domains") ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

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
