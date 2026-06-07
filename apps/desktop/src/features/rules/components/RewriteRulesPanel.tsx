import AddRoundedIcon from "@mui/icons-material/AddRounded";
import BugReportRoundedIcon from "@mui/icons-material/BugReportRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import FactCheckRoundedIcon from "@mui/icons-material/FactCheckRounded";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type {
  RewriteBodyFieldEdit,
  RewriteRule,
  RewriteRuleType,
  RuleMatch,
  SessionSummary,
} from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  useDeleteManagedRule,
  useRewriteRules,
  useSaveRewriteRule,
} from "@/features/rules/use-rule-center";
import {
  createEmptyRewriteRule,
  formatRuleMatch,
  getRewriteTypeLabel,
  getRewriteValidationErrors,
  HTTP_METHODS,
  wildcardMatch,
} from "@/features/rules/rules.helpers";
import {
  FieldGroup,
  formatRuleFieldLabel,
  InlineSwitch,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleSection,
} from "@/features/rules/components/RulesSharedUi";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type RewriteSeed = Pick<SessionSummary, "host" | "method" | "path" | "url">;
type RulesLocationState = { rewriteSeed?: RewriteSeed } | null;

type RewriteTemplate = {
  description: string;
  icon: "bug" | "route" | "tune";
  label: string;
  type: RewriteRuleType;
  build: () => RewriteRule;
};

type RuleTestInput = {
  method: string;
  stage: RuleMatch["stage"];
  url: string;
};

type HeaderRewriteRule = Extract<RewriteRule, { rewriteType: "header" }>;
type QueryRewriteRule = Extract<RewriteRule, { rewriteType: "query" }>;
type BodyRewriteRule = Extract<RewriteRule, { rewriteType: "body" }>;
type RedirectRewriteRule = Extract<RewriteRule, { rewriteType: "redirect" }>;

function createSeededRule(seed: RewriteSeed): RewriteRule {
  const rule = createEmptyRewriteRule("header") as HeaderRewriteRule;
  const pattern =
    seed.host && seed.path ? `${seed.host}${seed.path === "/" ? "" : seed.path}` : seed.url;

  return {
    ...rule,
    name: `Debug ${seed.host || "request"}`,
    match: {
      methods: [seed.method.toUpperCase()],
      stage: "request",
      urlPattern: pattern || seed.url,
    },
    payload: {
      headerName: "x-debug-mode",
      operation: "set",
      target: "request",
      value: "true",
    },
  };
}

function stageApplies(ruleStage: RuleMatch["stage"], currentStage: RuleMatch["stage"]) {
  return ruleStage === "either" || ruleStage === currentStage;
}

function testRuleMatch(rule: RewriteRule, input: RuleTestInput) {
  if (!rule.enabled) return { ok: false, reason: "Rule is disabled." };
  if (!stageApplies(rule.match.stage, input.stage))
    return { ok: false, reason: "Stage does not match." };
  if (
    rule.match.methods.length > 0 &&
    !rule.match.methods.some((method) => method.toUpperCase() === input.method.toUpperCase())
  ) {
    return { ok: false, reason: "HTTP method does not match." };
  }
  if (!wildcardMatch(rule.match.urlPattern, input.url, rule.match.matchType))
    return { ok: false, reason: "URL pattern does not match." };
  return { ok: true, reason: "This sample request matches the rule." };
}

function getInvalidRewriteCombination(rule: RewriteRule) {
  if (
    rule.match.stage === "response" &&
    (rule.rewriteType === "query" || rule.rewriteType === "redirect")
  ) {
    return "Query and Redirect rewrites run before the request is sent. Switch the stage to Request or Request or Response.";
  }
  if (
    rule.rewriteType === "header" &&
    rule.match.stage === "request" &&
    rule.payload.target === "response"
  ) {
    return "This rule matches the request stage, but the Header target is Response.";
  }
  if (
    rule.rewriteType === "header" &&
    rule.match.stage === "response" &&
    rule.payload.target === "request"
  ) {
    return "This rule matches the response stage, but the Header target is Request.";
  }
  if (
    rule.rewriteType === "body" &&
    rule.match.stage === "request" &&
    rule.payload.target === "response"
  ) {
    return "This rule matches the request stage, but the Body target is Response.";
  }
  if (
    rule.rewriteType === "body" &&
    rule.match.stage === "response" &&
    rule.payload.target === "request"
  ) {
    return "This rule matches the response stage, but the Body target is Request.";
  }
  return undefined;
}

function describeRewriteAction(rule: RewriteRule) {
  if (rule.rewriteType === "header") {
    return `${rule.payload.target} header ${rule.payload.operation}: ${rule.payload.headerName || "(name)"}`;
  }
  if (rule.rewriteType === "query") {
    return `query ${rule.payload.operation}: ${rule.payload.paramName || "(param)"}`;
  }
  if (rule.rewriteType === "body") {
    if ((rule.payload.mode ?? "replace") === "fields") {
      return `${rule.payload.target} body fields: ${rule.payload.fields?.length ?? 0}`;
    }
    return `${rule.payload.target} body -> ${rule.payload.contentType}`;
  }
  return `redirect -> ${rule.payload.targetUrl || "(target URL)"}`;
}

function TemplateIcon({ icon }: { icon: RewriteTemplate["icon"] }) {
  if (icon === "bug") return <BugReportRoundedIcon fontSize="small" />;
  if (icon === "route") return <RouteRoundedIcon fontSize="small" />;
  return <TuneRoundedIcon fontSize="small" />;
}

export function RewriteRulesPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: rules = [] } = useRewriteRules();
  const saveMutation = useSaveRewriteRule();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<RewriteRule>(createEmptyRewriteRule("header"));
  const [testInput, setTestInput] = useState<RuleTestInput>({
    method: "GET",
    stage: "request",
    url: "https://api.example.com/v1/users",
  });
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [validationAttempted, setValidationAttempted] = useState(false);

  const templates = useMemo<RewriteTemplate[]>(
    () => [
      {
        build: () => {
          const rule = createEmptyRewriteRule("header") as HeaderRewriteRule;
          return {
            ...rule,
            match: { methods: [], stage: "either", urlPattern: "*" },
            name: "Add debug header",
            payload: {
              headerName: "x-debug-mode",
              operation: "set",
              target: "request",
              value: "true",
            },
          };
        },
        description: "Mark matching traffic without touching app code.",
        icon: "bug",
        label: "Debug header",
        type: "header",
      },
      {
        build: () => {
          const rule = createEmptyRewriteRule("header") as HeaderRewriteRule;
          return {
            ...rule,
            match: { methods: [], stage: "response", urlPattern: "*" },
            name: "Disable response cache",
            payload: {
              headerName: "Cache-Control",
              operation: "set",
              target: "response",
              value: "no-store",
            },
          };
        },
        description: "Force fresh responses while debugging.",
        icon: "tune",
        label: "Disable cache",
        type: "header",
      },
      {
        build: () => {
          const rule = createEmptyRewriteRule("query") as QueryRewriteRule;
          return {
            ...rule,
            match: { methods: [], stage: "request", urlPattern: "*" },
            name: "Route query to staging",
            payload: { operation: "set", paramName: "env", value: "staging" },
          };
        },
        description: "Append a stable environment parameter.",
        icon: "route",
        label: "Env query",
        type: "query",
      },
      {
        build: () => {
          const rule = createEmptyRewriteRule("redirect") as RedirectRewriteRule;
          return {
            ...rule,
            match: { methods: [], stage: "request", urlPattern: "api.example.com/*" },
            name: "Redirect API to staging",
            payload: {
              preservePath: true,
              preserveQuery: true,
              targetUrl: "https://staging.example.com",
            },
          };
        },
        description: "Send matching requests to a staging upstream.",
        icon: "route",
        label: "Staging redirect",
        type: "redirect",
      },
      {
        build: () => {
          const rule = createEmptyRewriteRule("body") as BodyRewriteRule;
          return {
            ...rule,
            match: { methods: [], stage: "response", urlPattern: "*" },
            name: "Mock JSON response",
            payload: {
              contentType: "application/json",
              fields: [],
              mode: "replace",
              target: "response",
              text: '{\n  "ok": true\n}',
            },
          };
        },
        description: "Replace a response body with a known JSON shape.",
        icon: "tune",
        label: "Mock JSON",
        type: "body",
      },
    ],
    [],
  );

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .filter((r) => {
        if (!q) return true;
        return `${r.name} ${r.match.urlPattern} ${r.rewriteType}`.toLowerCase().includes(q);
      });
  }, [rules, searchValue]);

  useEffect(() => {
    const state = location.state as RulesLocationState;
    if (!state?.rewriteSeed) return;

    const seededRule = createSeededRule(state.rewriteSeed);
    setSelectedRuleId(seededRule.id);
    setDraft(seededRule);
    setValidationAttempted(false);
    setTestInput({
      method: state.rewriteSeed.method,
      stage: "request",
      url: state.rewriteSeed.url,
    });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    if (
      selectedRuleId &&
      (rules.some((r) => r.id === selectedRuleId) || draft.id === selectedRuleId)
    )
      return;
    const next = filteredRules[0];
    if (next) {
      setSelectedRuleId(next.id);
      setDraft(next);
      setValidationAttempted(false);
      return;
    }
    if (!selectedRuleId) return;
    setSelectedRuleId(undefined);
    setValidationAttempted(false);
  }, [draft.id, filteredRules, rules, selectedRuleId]);

  function selectRule(rule: RewriteRule) {
    setSelectedRuleId(rule.id);
    setDraft(rule);
    setValidationAttempted(false);
  }

  function handleCreateRule(rewriteType: RewriteRuleType) {
    const d = createEmptyRewriteRule(rewriteType);
    d.name = `${getRewriteTypeLabel(rewriteType, t)} rewrite`;
    setSelectedRuleId(d.id);
    setDraft(d);
    setValidationAttempted(false);
  }

  function applyTemplate(template: RewriteTemplate) {
    const next = template.build();
    setSelectedRuleId(next.id);
    setDraft(next);
    setTemplateDialogOpen(false);
    setValidationAttempted(false);
  }

  function handleSave() {
    setValidationAttempted(true);
    if (errors.length > 0) return;
    saveMutation.mutate(draft, {
      onSuccess: (saved) => {
        setSelectedRuleId(saved.id);
        setDraft(saved);
        setValidationAttempted(false);
      },
    });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
      setDraft(createEmptyRewriteRule());
      setSelectedRuleId(undefined);
      return;
    }
    deleteMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "rewrite" },
      {
        onSuccess: () => {
          setSelectedRuleId(undefined);
          setDraft(createEmptyRewriteRule());
        },
      },
    );
  }

  const invalidCombination = getInvalidRewriteCombination(draft);
  const errors = [
    ...getRewriteValidationErrors(draft, t),
    ...(invalidCombination ? [invalidCombination] : []),
  ];
  const testResult = testRuleMatch(draft, testInput);
  const httpMethodsLabel = formatRuleFieldLabel(t("rulesPage.labels.httpMethods"), "optional", t);

  return (
    <>
      <ManagedRulesWorkbench
        searchPlaceholder={t("rulesPage.rewrite.searchPlaceholder")}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        createActions={
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {(["header", "query", "body", "redirect"] as const).map((type) => (
              <Button
                key={type}
                size="small"
                variant="outlined"
                startIcon={<AddRoundedIcon />}
                onClick={() => handleCreateRule(type)}
              >
                {getRewriteTypeLabel(type, t)}
              </Button>
            ))}
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddRoundedIcon />}
              onClick={() => setTemplateDialogOpen(true)}
            >
              {t("rulesPage.rewrite.fromTemplate")}
            </Button>
          </Stack>
        }
        list={
          <ManagedRuleList
            emptyDescription={t("rulesPage.rewrite.emptyDescription")}
            items={filteredRules.map((rule) => ({
              id: rule.id,
              active: rule.id === selectedRuleId,
              enabled: rule.enabled,
              name: rule.name || t("rulesPage.untitledRule"),
              subtitle: `${formatRuleMatch(rule.match)} - ${describeRewriteAction(rule)}`,
              chipLabel: `${rule.priority}`,
              onClick: () => selectRule(rule),
            }))}
          />
        }
        editor={
          <Stack spacing={2}>
            <RewriteEditorHeader
              deletePending={deleteMutation.isPending}
              draft={draft}
              onChange={setDraft}
              onDelete={handleDelete}
              onSave={handleSave}
              savePending={saveMutation.isPending}
            />

            {validationAttempted && errors.length > 0 && (
              <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
                <Stack spacing={0.25}>
                  {errors.map((err) => (
                    <Typography key={err} variant="body2">
                      {err}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            )}

            <Box
              sx={{
                display: "grid",
                gap: 2,
                gridTemplateColumns: { xs: "1fr", xl: "minmax(0, 1fr) 320px" },
              }}
            >
              <Stack spacing={2} minWidth={0}>
                <RuleSection>
                  <FieldGroup title="When">
                    <TextField
                      size="small"
                      label={formatRuleFieldLabel(t("rulesPage.editor.urlPattern"), "required", t)}
                      value={draft.match.urlPattern}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          match: { ...draft.match, urlPattern: e.target.value },
                        })
                      }
                      placeholder={t("rulesPage.editor.urlPatternExample")}
                      fullWidth
                    />
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          color="text.secondary"
                          variant="caption"
                          sx={{ fontWeight: 650 }}
                        >
                          {t("rulesPage.editor.matchType")}
                        </Typography>
                        <Select
                          size="small"
                          value={draft.match.matchType ?? "contains"}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              match: { ...draft.match, matchType: e.target.value } as RuleMatch,
                            })
                          }
                        >
                          <MenuItem value="contains">
                            {t("rulesPage.editor.matchTypes.contains")}
                          </MenuItem>
                          <MenuItem value="wildcard">
                            {t("rulesPage.editor.matchTypes.wildcard")}
                          </MenuItem>
                          <MenuItem value="exact">
                            {t("rulesPage.editor.matchTypes.exact")}
                          </MenuItem>
                          <MenuItem value="regex">
                            {t("rulesPage.editor.matchTypes.regex")}
                          </MenuItem>
                        </Select>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ lineHeight: 1.35 }}
                        >
                          {t(
                            `rulesPage.editor.matchTypes.${draft.match.matchType ?? "contains"}Hint`,
                          )}
                        </Typography>
                      </Stack>
                    </Stack>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          color="text.secondary"
                          variant="caption"
                          sx={{ fontWeight: 650 }}
                        >
                          {httpMethodsLabel}
                        </Typography>
                        <Select
                          displayEmpty
                          multiple
                          size="small"
                          value={draft.match.methods}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              match: { ...draft.match, methods: e.target.value as string[] },
                            })
                          }
                          renderValue={(s) =>
                            s.length === 0 ? t("rulesPage.allMethods") : s.join(", ")
                          }
                        >
                          {HTTP_METHODS.map((m) => (
                            <MenuItem key={m} value={m}>
                              {m}
                            </MenuItem>
                          ))}
                        </Select>
                      </Stack>
                      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          color="text.secondary"
                          variant="caption"
                          sx={{ fontWeight: 650 }}
                        >
                          {formatRuleFieldLabel(t("rulesPage.editor.matchStage"), "required", t)}
                        </Typography>
                        <Select
                          size="small"
                          value={draft.match.stage}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              match: {
                                ...draft.match,
                                stage: e.target.value as RuleMatch["stage"],
                              },
                            })
                          }
                        >
                          <MenuItem value="either">
                            {t("rulesPage.editor.matchStageEither")}
                          </MenuItem>
                          <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                          <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                        </Select>
                      </Stack>
                    </Stack>
                  </FieldGroup>
                </RuleSection>

                <RuleSection>
                  <FieldGroup title="Then">
                    <ToggleButtonGroup
                      exclusive
                      fullWidth
                      onChange={(_, value: RewriteRuleType | null) => {
                        if (!value) return;
                        const nextDraft = createEmptyRewriteRule(value);
                        setDraft({
                          ...nextDraft,
                          id: draft.id,
                          name: draft.name,
                          enabled: draft.enabled,
                          priority: draft.priority,
                          match: draft.match,
                          ...(draft.note ? { note: draft.note } : {}),
                        });
                      }}
                      size="small"
                      value={draft.rewriteType}
                    >
                      <ToggleButton value="header">{getRewriteTypeLabel("header", t)}</ToggleButton>
                      <ToggleButton value="query">{getRewriteTypeLabel("query", t)}</ToggleButton>
                      <ToggleButton value="body">{getRewriteTypeLabel("body", t)}</ToggleButton>
                      <ToggleButton value="redirect">
                        {getRewriteTypeLabel("redirect", t)}
                      </ToggleButton>
                    </ToggleButtonGroup>
                    <RewriteActionFields rule={draft} onChange={setDraft} />
                  </FieldGroup>
                </RuleSection>
              </Stack>

              <RewriteRuleTester
                draft={draft}
                testInput={testInput}
                testResult={testResult}
                onChange={setTestInput}
              />
            </Box>
          </Stack>
        }
      />

      <Dialog
        fullWidth
        maxWidth="sm"
        open={templateDialogOpen}
        onClose={() => setTemplateDialogOpen(false)}
      >
        <DialogTitle>{t("rulesPage.rewrite.templatesTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={1} sx={{ pb: 1 }}>
            {templates.map((template) => (
              <Button
                key={template.label}
                color="inherit"
                onClick={() => applyTemplate(template)}
                size="small"
                startIcon={<TemplateIcon icon={template.icon} />}
                sx={{
                  alignItems: "flex-start",
                  border: 1,
                  borderColor: "divider",
                  justifyContent: "flex-start",
                  px: 1,
                  py: 0.85,
                  textAlign: "left",
                }}
              >
                <Stack spacing={0.15}>
                  <Stack alignItems="center" direction="row" spacing={0.75}>
                    <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 700 }}>
                      {template.label}
                    </Typography>
                    <Chip
                      size="small"
                      label={getRewriteTypeLabel(template.type, t)}
                      sx={{ height: 18, fontSize: 10 }}
                    />
                  </Stack>
                  <Typography color="text.secondary" variant="caption">
                    {template.description}
                  </Typography>
                </Stack>
              </Button>
            ))}
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RewriteEditorHeader({
  deletePending,
  draft,
  onChange,
  onDelete,
  onSave,
  savePending,
}: {
  deletePending: boolean;
  draft: RewriteRule;
  onChange: (rule: RewriteRule) => void;
  onDelete: () => void;
  onSave: () => void;
  savePending: boolean;
}) {
  const { t } = useI18n();

  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.1 : 0.045),
        border: 1,
        borderColor: alpha(theme.palette.primary.main, 0.18),
        borderRadius: "8px",
        p: 1.5,
        "& .MuiInputLabel-root.MuiInputLabel-shrink": {
          bgcolor:
            theme.palette.mode === "dark"
              ? theme.palette.background.paper
              : theme.palette.background.default,
          px: 0.5,
        },
      })}
    >
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1.25}
        alignItems={{ xs: "stretch", md: "center" }}
      >
        <TextField
          size="small"
          label={formatRuleFieldLabel(t("rulesPage.editor.ruleName"), "required", t)}
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          sx={{ flex: 1 }}
        />
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{ border: 1, borderColor: "divider", borderRadius: "8px", minHeight: 40, px: 1 }}
        >
          <Typography color="text.secondary" variant="caption">
            {t("rulesPage.editor.enabled")}
          </Typography>
          <Switch
            size="small"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          />
        </Stack>
        <TextField
          size="small"
          type="number"
          label={formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t)}
          value={draft.priority}
          onChange={(e) => onChange({ ...draft, priority: Number(e.target.value) || 0 })}
          sx={{ width: { xs: "100%", md: 136 } }}
        />
        <Tooltip title={t("common.actions.remove")}>
          <span>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteRoundedIcon />}
              onClick={onDelete}
              disabled={deletePending}
            >
              {t("common.actions.remove")}
            </Button>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="contained"
          startIcon={<SaveRoundedIcon />}
          onClick={onSave}
          disabled={savePending}
        >
          {t("rulesPage.editor.saveRule")}
        </Button>
      </Stack>
    </Paper>
  );
}

function RewriteRuleTester({
  draft,
  onChange,
  testInput,
  testResult,
}: {
  draft: RewriteRule;
  onChange: (input: RuleTestInput) => void;
  testInput: RuleTestInput;
  testResult: { ok: boolean; reason: string };
}) {
  const { t } = useI18n();
  const sampleUrlLabel = formatRuleFieldLabel("Sample URL", "optional", t);
  const methodLabel = formatRuleFieldLabel("Method", "optional", t);
  const stageLabel = formatRuleFieldLabel("Stage", "optional", t);

  return (
    <RuleSection>
      <FieldGroup title="Test">
        <Stack direction="row" spacing={0.75} alignItems="center">
          <FactCheckRoundedIcon color={testResult.ok ? "success" : "disabled"} fontSize="small" />
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            Rule tester
          </Typography>
        </Stack>
        <TextField
          label={sampleUrlLabel}
          onChange={(e) => onChange({ ...testInput, url: e.target.value })}
          size="small"
          value={testInput.url}
        />
        <Stack direction="row" spacing={1}>
          <FormControl size="small" fullWidth>
            <InputLabel>{methodLabel}</InputLabel>
            <Select
              label={methodLabel}
              value={testInput.method}
              onChange={(e) => onChange({ ...testInput, method: e.target.value })}
            >
              {HTTP_METHODS.map((method) => (
                <MenuItem key={method} value={method}>
                  {method}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>{stageLabel}</InputLabel>
            <Select
              label={stageLabel}
              value={testInput.stage}
              onChange={(e) =>
                onChange({ ...testInput, stage: e.target.value as RuleMatch["stage"] })
              }
            >
              <MenuItem value="request">Request</MenuItem>
              <MenuItem value="response">Response</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <Alert severity={testResult.ok ? "success" : "info"} variant="outlined" sx={{ py: 0.25 }}>
          {testResult.reason}
        </Alert>
        <Typography color="text.secondary" variant="caption">
          {testResult.ok
            ? describeRewriteAction(draft)
            : `Waiting for ${draft.match.urlPattern || "(url pattern)"}`}
        </Typography>
      </FieldGroup>
    </RuleSection>
  );
}

function RewriteActionFields(props: { onChange: (rule: RewriteRule) => void; rule: RewriteRule }) {
  const { t } = useI18n();
  const { onChange, rule } = props;
  const required = (label: string) => formatRuleFieldLabel(label, "required", t);
  const optional = (label: string) => formatRuleFieldLabel(label, "optional", t);

  if (rule.rewriteType === "header") {
    const targetLabel = required(t("rulesPage.rewrite.headerTarget"));
    const operationLabel = required(t("rulesPage.rewrite.operation"));
    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{targetLabel}</InputLabel>
            <Select
              label={targetLabel}
              value={rule.payload.target}
              onChange={(e) =>
                onChange({
                  ...rule,
                  payload: { ...rule.payload, target: e.target.value as "request" | "response" },
                })
              }
            >
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>{operationLabel}</InputLabel>
            <Select
              label={operationLabel}
              value={rule.payload.operation}
              onChange={(e) =>
                onChange({
                  ...rule,
                  payload: { ...rule.payload, operation: e.target.value as "set" | "remove" },
                })
              }
            >
              <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
              <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <TextField
          size="small"
          label={required(t("rulesPage.rewrite.headerName"))}
          value={rule.payload.headerName}
          onChange={(e) =>
            onChange({ ...rule, payload: { ...rule.payload, headerName: e.target.value } })
          }
          placeholder={t("rulesPage.rewrite.headerNameExample")}
        />
        {rule.payload.operation === "set" && (
          <TextField
            size="small"
            label={required(t("rulesPage.rewrite.headerValue"))}
            value={rule.payload.value ?? ""}
            onChange={(e) =>
              onChange({ ...rule, payload: { ...rule.payload, value: e.target.value } })
            }
            placeholder={t("rulesPage.rewrite.headerValueExample")}
          />
        )}
      </Stack>
    );
  }

  if (rule.rewriteType === "query") {
    const operationLabel = required(t("rulesPage.rewrite.operation"));
    return (
      <Stack spacing={1.5}>
        <FormControl size="small" fullWidth>
          <InputLabel>{operationLabel}</InputLabel>
          <Select
            label={operationLabel}
            value={rule.payload.operation}
            onChange={(e) =>
              onChange({
                ...rule,
                payload: { ...rule.payload, operation: e.target.value as "set" | "remove" },
              })
            }
          >
            <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
            <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          label={required(t("rulesPage.rewrite.queryName"))}
          value={rule.payload.paramName}
          onChange={(e) =>
            onChange({ ...rule, payload: { ...rule.payload, paramName: e.target.value } })
          }
          placeholder={t("rulesPage.rewrite.queryNameExample")}
        />
        {rule.payload.operation === "set" && (
          <TextField
            size="small"
            label={required(t("rulesPage.rewrite.queryValue"))}
            value={rule.payload.value ?? ""}
            onChange={(e) =>
              onChange({ ...rule, payload: { ...rule.payload, value: e.target.value } })
            }
            placeholder={t("rulesPage.rewrite.queryValueExample")}
          />
        )}
      </Stack>
    );
  }

  if (rule.rewriteType === "body") {
    const targetLabel = required(t("rulesPage.rewrite.bodyTarget"));
    const mode = rule.payload.mode ?? "replace";
    const fields = rule.payload.fields ?? [];
    const updateField = (index: number, patch: Partial<RewriteBodyFieldEdit>) => {
      onChange({
        ...rule,
        payload: {
          ...rule.payload,
          fields: fields.map((field, fieldIndex) =>
            fieldIndex === index ? { ...field, ...patch } : field,
          ),
        },
      });
    };
    const addField = () => {
      onChange({
        ...rule,
        payload: {
          ...rule.payload,
          fields: [...fields, { operation: "set", path: "", value: "", valueType: "string" }],
        },
      });
    };
    const removeField = (index: number) => {
      onChange({
        ...rule,
        payload: {
          ...rule.payload,
          fields: fields.filter((_, fieldIndex) => fieldIndex !== index),
        },
      });
    };

    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{targetLabel}</InputLabel>
            <Select
              label={targetLabel}
              value={rule.payload.target}
              onChange={(e) =>
                onChange({
                  ...rule,
                  payload: { ...rule.payload, target: e.target.value as "request" | "response" },
                })
              }
            >
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label={optional(t("rulesPage.rewrite.contentType"))}
            value={rule.payload.contentType}
            onChange={(e) =>
              onChange({ ...rule, payload: { ...rule.payload, contentType: e.target.value } })
            }
          />
        </Stack>
        <ToggleButtonGroup
          exclusive
          fullWidth
          onChange={(_, value: "replace" | "fields" | null) => {
            if (!value) return;
            onChange({
              ...rule,
              payload: {
                ...rule.payload,
                fields: rule.payload.fields?.length
                  ? rule.payload.fields
                  : [{ operation: "set", path: "", value: "", valueType: "string" }],
                mode: value,
              },
            });
          }}
          size="small"
          value={mode}
        >
          <ToggleButton value="replace">{t("rulesPage.rewrite.bodyModes.replace")}</ToggleButton>
          <ToggleButton value="fields">{t("rulesPage.rewrite.bodyModes.fields")}</ToggleButton>
        </ToggleButtonGroup>
        {mode === "replace" ? (
          <TextField
            size="small"
            multiline
            minRows={6}
            label={required(t("rulesPage.rewrite.bodyText"))}
            value={rule.payload.text ?? ""}
            onChange={(e) =>
              onChange({ ...rule, payload: { ...rule.payload, text: e.target.value } })
            }
            sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
          />
        ) : (
          <Stack spacing={1}>
            {fields.length === 0 ? (
              <Alert severity="info" variant="outlined" sx={{ py: 0.25 }}>
                {t("rulesPage.rewrite.bodyFieldsEmpty")}
              </Alert>
            ) : (
              fields.map((field, index) => {
                const pathLabel = required(t("rulesPage.rewrite.bodyFieldPath"));
                const operationLabel = required(t("rulesPage.rewrite.operation"));
                const valueTypeLabel = required(t("rulesPage.rewrite.bodyValueType"));
                const valueLabel = required(t("rulesPage.rewrite.bodyFieldValue"));
                return (
                  <Box
                    key={index}
                    sx={{
                      display: "grid",
                      gap: 1,
                      gridTemplateColumns: {
                        xs: "1fr",
                        md: "minmax(160px, 1.1fr) 120px 120px minmax(180px, 1fr) auto",
                      },
                    }}
                  >
                    <TextField
                      size="small"
                      label={pathLabel}
                      placeholder={t("rulesPage.rewrite.bodyFieldPathExample")}
                      value={field.path}
                      onChange={(e) => updateField(index, { path: e.target.value })}
                      sx={{
                        "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 },
                      }}
                    />
                    <FormControl size="small">
                      <InputLabel>{operationLabel}</InputLabel>
                      <Select
                        label={operationLabel}
                        value={field.operation}
                        onChange={(e) =>
                          updateField(index, {
                            operation: e.target.value as RewriteBodyFieldEdit["operation"],
                          })
                        }
                      >
                        <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
                        <MenuItem value="remove">
                          {t("rulesPage.rewrite.operations.remove")}
                        </MenuItem>
                      </Select>
                    </FormControl>
                    <FormControl size="small" disabled={field.operation === "remove"}>
                      <InputLabel>{valueTypeLabel}</InputLabel>
                      <Select
                        label={valueTypeLabel}
                        value={field.valueType ?? "string"}
                        onChange={(e) =>
                          updateField(index, {
                            valueType: e.target.value as NonNullable<
                              RewriteBodyFieldEdit["valueType"]
                            >,
                          })
                        }
                      >
                        <MenuItem value="string">
                          {t("rulesPage.rewrite.bodyValueTypes.string")}
                        </MenuItem>
                        <MenuItem value="number">
                          {t("rulesPage.rewrite.bodyValueTypes.number")}
                        </MenuItem>
                        <MenuItem value="boolean">
                          {t("rulesPage.rewrite.bodyValueTypes.boolean")}
                        </MenuItem>
                        <MenuItem value="null">
                          {t("rulesPage.rewrite.bodyValueTypes.null")}
                        </MenuItem>
                        <MenuItem value="json">
                          {t("rulesPage.rewrite.bodyValueTypes.json")}
                        </MenuItem>
                      </Select>
                    </FormControl>
                    <TextField
                      disabled={field.operation === "remove" || field.valueType === "null"}
                      size="small"
                      label={valueLabel}
                      value={field.value ?? ""}
                      onChange={(e) => updateField(index, { value: e.target.value })}
                      sx={{
                        "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 },
                      }}
                    />
                    <Button
                      color="error"
                      onClick={() => removeField(index)}
                      size="small"
                      startIcon={<DeleteRoundedIcon />}
                      variant="outlined"
                      sx={{ minWidth: { xs: "100%", md: 44 }, px: { xs: 1.5, md: 1 } }}
                    >
                      {t("common.actions.remove")}
                    </Button>
                  </Box>
                );
              })
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddRoundedIcon />}
              onClick={addField}
              sx={{ alignSelf: "flex-start" }}
            >
              {t("rulesPage.rewrite.addBodyField")}
            </Button>
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={required(t("rulesPage.rewrite.redirectTarget"))}
        value={rule.payload.targetUrl}
        onChange={(e) =>
          onChange({ ...rule, payload: { ...rule.payload, targetUrl: e.target.value } })
        }
        placeholder={t("rulesPage.rewrite.redirectTargetExample")}
      />
      <Stack direction="row" spacing={2}>
        <InlineSwitch
          label={t("rulesPage.rewrite.preservePath")}
          checked={rule.payload.preservePath}
          onChange={(v) => onChange({ ...rule, payload: { ...rule.payload, preservePath: v } })}
        />
        <InlineSwitch
          label={t("rulesPage.rewrite.preserveQuery")}
          checked={rule.payload.preserveQuery}
          onChange={(v) => onChange({ ...rule, payload: { ...rule.payload, preserveQuery: v } })}
        />
      </Stack>
    </Stack>
  );
}
