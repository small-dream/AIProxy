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
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  OutlinedInput,
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
import type { RewriteRule, RewriteRuleType, RuleMatch, SessionSummary } from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useDeleteManagedRule, useRewriteRules, useSaveRewriteRule } from "@/features/rules/use-rule-center";
import {
  createEmptyRewriteRule,
  formatRuleMatch,
  getRewriteTypeLabel,
  getRewriteValidationErrors,
  HTTP_METHODS,
} from "@/features/rules/rules.helpers";
import { FieldGroup, InlineSwitch, ManagedRuleList, ManagedRulesWorkbench, RuleSection } from "@/features/rules/components/RulesSharedUi";
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
  const pattern = seed.host && seed.path ? `${seed.host}${seed.path === "/" ? "" : seed.path}` : seed.url;

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

function wildcardMatch(pattern: string, candidate: string) {
  const normalized = pattern.trim();
  if (!normalized || normalized === "*") return true;
  if (!normalized.includes("*")) return candidate.includes(normalized);
  const parts = normalized.split("*").filter(Boolean);
  let cursor = 0;
  for (const [index, part] of parts.entries()) {
    const found = candidate.slice(cursor).indexOf(part);
    if (found < 0) return false;
    const absolute = cursor + found;
    if (index === 0 && !normalized.startsWith("*") && absolute !== 0) return false;
    cursor = absolute + part.length;
  }
  return normalized.endsWith("*") || candidate.endsWith(parts.at(-1) ?? "");
}

function testRuleMatch(rule: RewriteRule, input: RuleTestInput) {
  if (!rule.enabled) return { ok: false, reason: "Rule is disabled." };
  if (!stageApplies(rule.match.stage, input.stage)) return { ok: false, reason: "Stage does not match." };
  if (rule.match.methods.length > 0 && !rule.match.methods.some((method) => method.toUpperCase() === input.method.toUpperCase())) {
    return { ok: false, reason: "HTTP method does not match." };
  }
  if (!wildcardMatch(rule.match.urlPattern, input.url)) return { ok: false, reason: "URL pattern does not match." };
  return { ok: true, reason: "This sample request matches the rule." };
}

function getInvalidRewriteCombination(rule: RewriteRule) {
  if (rule.match.stage === "response" && (rule.rewriteType === "query" || rule.rewriteType === "redirect")) {
    return "Query and Redirect rewrites run before the request is sent. Switch the stage to Request or Request or Response.";
  }
  if (rule.rewriteType === "header" && rule.match.stage === "request" && rule.payload.target === "response") {
    return "This rule matches the request stage, but the Header target is Response.";
  }
  if (rule.rewriteType === "header" && rule.match.stage === "response" && rule.payload.target === "request") {
    return "This rule matches the response stage, but the Header target is Request.";
  }
  if (rule.rewriteType === "body" && rule.match.stage === "request" && rule.payload.target === "response") {
    return "This rule matches the request stage, but the Body target is Response.";
  }
  if (rule.rewriteType === "body" && rule.match.stage === "response" && rule.payload.target === "request") {
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
  const [testInput, setTestInput] = useState<RuleTestInput>({ method: "GET", stage: "request", url: "https://api.example.com/v1/users" });

  const templates = useMemo<RewriteTemplate[]>(() => [
    {
      build: () => {
        const rule = createEmptyRewriteRule("header") as HeaderRewriteRule;
        return {
          ...rule,
          match: { methods: [], stage: "either", urlPattern: "*" },
          name: "Add debug header",
          payload: { headerName: "x-debug-mode", operation: "set", target: "request", value: "true" },
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
          payload: { headerName: "Cache-Control", operation: "set", target: "response", value: "no-store" },
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
          payload: { preservePath: true, preserveQuery: true, targetUrl: "https://staging.example.com" },
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
          payload: { contentType: "application/json", target: "response", text: "{\n  \"ok\": true\n}" },
        };
      },
      description: "Replace a response body with a known JSON shape.",
      icon: "tune",
      label: "Mock JSON",
      type: "body",
    },
  ], []);

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules].sort((a, b) => b.priority - a.priority).filter((r) => {
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
    setTestInput({
      method: state.rewriteSeed.method,
      stage: "request",
      url: state.rewriteSeed.url,
    });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    if (selectedRuleId && (rules.some((r) => r.id === selectedRuleId) || draft.id === selectedRuleId)) return;
    const next = filteredRules[0];
    if (next) { setSelectedRuleId(next.id); setDraft(next); return; }
    if (!selectedRuleId) return;
    setSelectedRuleId(undefined);
  }, [draft.id, filteredRules, rules, selectedRuleId]);

  function selectRule(rule: RewriteRule) { setSelectedRuleId(rule.id); setDraft(rule); }

  function handleCreateRule(rewriteType: RewriteRuleType) {
    const d = createEmptyRewriteRule(rewriteType);
    d.name = `${getRewriteTypeLabel(rewriteType, t)} rewrite`;
    setSelectedRuleId(d.id);
    setDraft(d);
  }

  function applyTemplate(template: RewriteTemplate) {
    const next = template.build();
    setSelectedRuleId(next.id);
    setDraft(next);
  }

  function handleSave() {
    saveMutation.mutate(draft, { onSuccess: (saved) => { setSelectedRuleId(saved.id); setDraft(saved); } });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) { setDraft(createEmptyRewriteRule()); setSelectedRuleId(undefined); return; }
    deleteMutation.mutate({ ruleId: selectedRuleId, ruleType: "rewrite" }, { onSuccess: () => { setSelectedRuleId(undefined); setDraft(createEmptyRewriteRule()); } });
  }

  const invalidCombination = getInvalidRewriteCombination(draft);
  const errors = [...getRewriteValidationErrors(draft, t), ...(invalidCombination ? [invalidCombination] : [])];
  const testResult = testRuleMatch(draft, testInput);

  return (
    <ManagedRulesWorkbench
      searchPlaceholder={t("rulesPage.rewrite.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={(
        <Stack spacing={1.25} sx={{ width: "100%" }}>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {(["header", "query", "body", "redirect"] as const).map((type) => (
              <Button key={type} size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => handleCreateRule(type)}>
                {getRewriteTypeLabel(type, t)}
              </Button>
            ))}
          </Stack>
          <Divider />
          <Stack spacing={0.75}>
            <Typography color="text.secondary" variant="caption" sx={{ fontWeight: 700 }}>
              Templates
            </Typography>
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
                    <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 700 }}>{template.label}</Typography>
                    <Chip size="small" label={getRewriteTypeLabel(template.type, t)} sx={{ height: 18, fontSize: 10 }} />
                  </Stack>
                  <Typography color="text.secondary" variant="caption">{template.description}</Typography>
                </Stack>
              </Button>
            ))}
          </Stack>
        </Stack>
      )}
      list={(
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
      )}
      editor={(
        <Stack spacing={2}>
          <RewriteEditorHeader
            deletePending={deleteMutation.isPending}
            draft={draft}
            errors={errors}
            onChange={setDraft}
            onDelete={handleDelete}
            onSave={handleSave}
            savePending={saveMutation.isPending}
          />

          {errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
              <Stack spacing={0.25}>
                {errors.map((err) => <Typography key={err} variant="body2">{err}</Typography>)}
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
                    label={t("rulesPage.editor.urlPattern")}
                    value={draft.match.urlPattern}
                    onChange={(e) => setDraft({ ...draft, match: { ...draft.match, urlPattern: e.target.value } })}
                    placeholder={t("rulesPage.editor.urlPatternExample")}
                    fullWidth
                  />
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>{t("rulesPage.labels.httpMethods")}</InputLabel>
                      <Select
                        multiple
                        value={draft.match.methods}
                        onChange={(e) => setDraft({ ...draft, match: { ...draft.match, methods: e.target.value as string[] } })}
                        input={<OutlinedInput label={t("rulesPage.labels.httpMethods")} />}
                        renderValue={(s) => (s.length === 0 ? t("rulesPage.allMethods") : s.join(", "))}
                      >
                        {HTTP_METHODS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                      </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: 180 }}>
                      <InputLabel>{t("rulesPage.editor.matchStage")}</InputLabel>
                      <Select
                        label={t("rulesPage.editor.matchStage")}
                        value={draft.match.stage}
                        onChange={(e) => setDraft({ ...draft, match: { ...draft.match, stage: e.target.value as RuleMatch["stage"] } })}
                      >
                        <MenuItem value="either">{t("rulesPage.editor.matchStageEither")}</MenuItem>
                        <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                        <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                      </Select>
                    </FormControl>
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
                      setDraft({ ...nextDraft, id: draft.id, name: draft.name, enabled: draft.enabled, priority: draft.priority, match: draft.match, ...(draft.note ? { note: draft.note } : {}) });
                    }}
                    size="small"
                    value={draft.rewriteType}
                  >
                    <ToggleButton value="header">{getRewriteTypeLabel("header", t)}</ToggleButton>
                    <ToggleButton value="query">{getRewriteTypeLabel("query", t)}</ToggleButton>
                    <ToggleButton value="body">{getRewriteTypeLabel("body", t)}</ToggleButton>
                    <ToggleButton value="redirect">{getRewriteTypeLabel("redirect", t)}</ToggleButton>
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
      )}
    />
  );
}

function RewriteEditorHeader({
  deletePending,
  draft,
  errors,
  onChange,
  onDelete,
  onSave,
  savePending,
}: {
  deletePending: boolean;
  draft: RewriteRule;
  errors: string[];
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
      })}
    >
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} alignItems={{ xs: "stretch", md: "center" }}>
        <TextField size="small" label={t("rulesPage.editor.ruleName")} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} sx={{ flex: 1 }} />
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", minHeight: 40, px: 1 }}>
          <Typography color="text.secondary" variant="caption">{t("rulesPage.editor.enabled")}</Typography>
          <Switch size="small" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.target.checked })} />
        </Stack>
        <TextField size="small" type="number" label={t("rulesPage.editor.priority")} value={draft.priority} onChange={(e) => onChange({ ...draft, priority: Number(e.target.value) || 0 })} sx={{ width: { xs: "100%", md: 116 } }} />
        <Tooltip title={t("common.actions.remove")}>
          <span>
            <Button size="small" variant="outlined" color="error" startIcon={<DeleteRoundedIcon />} onClick={onDelete} disabled={deletePending}>
              {t("common.actions.remove")}
            </Button>
          </span>
        </Tooltip>
        <Button size="small" variant="contained" startIcon={<SaveRoundedIcon />} onClick={onSave} disabled={errors.length > 0 || savePending}>
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
  return (
    <RuleSection>
      <FieldGroup title="Test">
        <Stack direction="row" spacing={0.75} alignItems="center">
          <FactCheckRoundedIcon color={testResult.ok ? "success" : "disabled"} fontSize="small" />
          <Typography variant="body2" sx={{ fontWeight: 700 }}>Rule tester</Typography>
        </Stack>
        <TextField
          label="Sample URL"
          onChange={(e) => onChange({ ...testInput, url: e.target.value })}
          size="small"
          value={testInput.url}
        />
        <Stack direction="row" spacing={1}>
          <FormControl size="small" fullWidth>
            <InputLabel>Method</InputLabel>
            <Select label="Method" value={testInput.method} onChange={(e) => onChange({ ...testInput, method: e.target.value })}>
              {HTTP_METHODS.map((method) => <MenuItem key={method} value={method}>{method}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Stage</InputLabel>
            <Select label="Stage" value={testInput.stage} onChange={(e) => onChange({ ...testInput, stage: e.target.value as RuleMatch["stage"] })}>
              <MenuItem value="request">Request</MenuItem>
              <MenuItem value="response">Response</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <Alert severity={testResult.ok ? "success" : "info"} variant="outlined" sx={{ py: 0.25 }}>
          {testResult.reason}
        </Alert>
        <Typography color="text.secondary" variant="caption">
          {testResult.ok ? describeRewriteAction(draft) : `Waiting for ${draft.match.urlPattern || "(url pattern)"}`}
        </Typography>
      </FieldGroup>
    </RuleSection>
  );
}

function RewriteActionFields(props: { onChange: (rule: RewriteRule) => void; rule: RewriteRule }) {
  const { t } = useI18n();
  const { onChange, rule } = props;

  if (rule.rewriteType === "header") {
    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{t("rulesPage.rewrite.headerTarget")}</InputLabel>
            <Select label={t("rulesPage.rewrite.headerTarget")} value={rule.payload.target} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, target: e.target.value as "request" | "response" } })}>
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>{t("rulesPage.rewrite.operation")}</InputLabel>
            <Select label={t("rulesPage.rewrite.operation")} value={rule.payload.operation} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, operation: e.target.value as "set" | "remove" } })}>
              <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
              <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <TextField size="small" label={t("rulesPage.rewrite.headerName")} value={rule.payload.headerName} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, headerName: e.target.value } })} placeholder={t("rulesPage.rewrite.headerNameExample")} />
        {rule.payload.operation === "set" && (
          <TextField size="small" label={t("rulesPage.rewrite.headerValue")} value={rule.payload.value ?? ""} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, value: e.target.value } })} placeholder={t("rulesPage.rewrite.headerValueExample")} />
        )}
      </Stack>
    );
  }

  if (rule.rewriteType === "query") {
    return (
      <Stack spacing={1.5}>
        <FormControl size="small" fullWidth>
          <InputLabel>{t("rulesPage.rewrite.operation")}</InputLabel>
          <Select label={t("rulesPage.rewrite.operation")} value={rule.payload.operation} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, operation: e.target.value as "set" | "remove" } })}>
            <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
            <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
          </Select>
        </FormControl>
        <TextField size="small" label={t("rulesPage.rewrite.queryName")} value={rule.payload.paramName} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, paramName: e.target.value } })} placeholder={t("rulesPage.rewrite.queryNameExample")} />
        {rule.payload.operation === "set" && (
          <TextField size="small" label={t("rulesPage.rewrite.queryValue")} value={rule.payload.value ?? ""} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, value: e.target.value } })} placeholder={t("rulesPage.rewrite.queryValueExample")} />
        )}
      </Stack>
    );
  }

  if (rule.rewriteType === "body") {
    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{t("rulesPage.rewrite.bodyTarget")}</InputLabel>
            <Select label={t("rulesPage.rewrite.bodyTarget")} value={rule.payload.target} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, target: e.target.value as "request" | "response" } })}>
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <TextField size="small" label={t("rulesPage.rewrite.contentType")} value={rule.payload.contentType} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, contentType: e.target.value } })} />
        </Stack>
        <TextField
          size="small"
          multiline
          minRows={6}
          label={t("rulesPage.rewrite.bodyText")}
          value={rule.payload.text}
          onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, text: e.target.value } })}
          sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      <TextField size="small" label={t("rulesPage.rewrite.redirectTarget")} value={rule.payload.targetUrl} onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, targetUrl: e.target.value } })} placeholder={t("rulesPage.rewrite.redirectTargetExample")} />
      <Stack direction="row" spacing={2}>
        <InlineSwitch label={t("rulesPage.rewrite.preservePath")} checked={rule.payload.preservePath} onChange={(v) => onChange({ ...rule, payload: { ...rule.payload, preservePath: v } })} />
        <InlineSwitch label={t("rulesPage.rewrite.preserveQuery")} checked={rule.payload.preserveQuery} onChange={(v) => onChange({ ...rule, payload: { ...rule.payload, preserveQuery: v } })} />
      </Stack>
    </Stack>
  );
}
