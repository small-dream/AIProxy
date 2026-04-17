import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
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
  Typography,
} from "@mui/material";
import type { RewriteRule, RewriteRuleType, RuleMatch } from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useDeleteManagedRule, useRewriteRules, useSaveRewriteRule } from "@/features/rules/use-rule-center";
import {
  createEmptyRewriteRule,
  formatRuleMatch,
  getRewriteTypeLabel,
  getRewriteValidationErrors,
  HTTP_METHODS,
} from "@/features/rules/rules.helpers";
import { FieldGroup, InlineSwitch, ManagedRuleList, ManagedRulesWorkbench } from "@/features/rules/components/RulesSharedUi";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function RewriteRulesPanel() {
  const { t } = useI18n();
  const { data: rules = [] } = useRewriteRules();
  const saveMutation = useSaveRewriteRule();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<RewriteRule>(createEmptyRewriteRule("header"));

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules].sort((a, b) => b.priority - a.priority).filter((r) => {
      if (!q) return true;
      return `${r.name} ${r.match.urlPattern} ${r.rewriteType}`.toLowerCase().includes(q);
    });
  }, [rules, searchValue]);

  useEffect(() => {
    if (selectedRuleId && rules.some((r) => r.id === selectedRuleId)) return;
    const next = filteredRules[0];
    if (next) { setSelectedRuleId(next.id); setDraft(next); return; }
    setSelectedRuleId(undefined);
  }, [filteredRules, rules, selectedRuleId]);

  function selectRule(rule: RewriteRule) { setSelectedRuleId(rule.id); setDraft(rule); }

  function handleCreateRule(rewriteType: RewriteRuleType) {
    const d = createEmptyRewriteRule(rewriteType);
    setSelectedRuleId(d.id);
    setDraft(d);
  }

  function handleSave() {
    saveMutation.mutate(draft, { onSuccess: (saved) => { setSelectedRuleId(saved.id); setDraft(saved); } });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) { setDraft(createEmptyRewriteRule()); setSelectedRuleId(undefined); return; }
    deleteMutation.mutate({ ruleId: selectedRuleId, ruleType: "rewrite" }, { onSuccess: () => { setSelectedRuleId(undefined); setDraft(createEmptyRewriteRule()); } });
  }

  const errors = getRewriteValidationErrors(draft, t);

  return (
    <ManagedRulesWorkbench
      searchPlaceholder={t("rulesPage.rewrite.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={(
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("header")}>{t("rulesPage.rewrite.types.header")}</Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("query")}>{t("rulesPage.rewrite.types.query")}</Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("body")}>{t("rulesPage.rewrite.types.body")}</Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("redirect")}>{t("rulesPage.rewrite.types.redirect")}</Button>
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
            subtitle: `${formatRuleMatch(rule.match)} • ${getRewriteTypeLabel(rule.rewriteType, t)}`,
            chipLabel: `${rule.priority}`,
            onClick: () => selectRule(rule),
          }))}
        />
      )}
      editor={(
        <Stack spacing={2}>
          {/* Top bar */}
          <Stack direction="row" spacing={1.5} alignItems="center">
            <TextField size="small" label={t("rulesPage.editor.ruleName")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} sx={{ flex: 1 }} />
            <Switch size="small" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            <TextField size="small" type="number" label={t("rulesPage.editor.priority")} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })} sx={{ width: 110 }} />
            <Button size="small" variant="outlined" color="error" startIcon={<DeleteRoundedIcon />} onClick={handleDelete} disabled={deleteMutation.isPending}>
              {t("common.actions.remove")}
            </Button>
            <Button size="small" variant="contained" startIcon={<SaveRoundedIcon />} onClick={handleSave} disabled={errors.length > 0 || saveMutation.isPending}>
              {t("rulesPage.editor.saveRule")}
            </Button>
          </Stack>

          {/* Validation */}
          {errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
              <Stack spacing={0.25}>
                {errors.map((err) => <Typography key={err} variant="body2">{err}</Typography>)}
              </Stack>
            </Alert>
          )}

          {/* Match conditions */}
          <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
            <FieldGroup title={t("rulesPage.editor.matchTitle")}>
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
                <FormControl size="small" sx={{ minWidth: 160 }}>
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
          </Paper>

          {/* Action config */}
          <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
            <FieldGroup title={t("rulesPage.editor.actionTitle")}>
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel>{t("rulesPage.editor.ruleType")}</InputLabel>
                <Select
                  label={t("rulesPage.editor.ruleType")}
                  value={draft.rewriteType}
                  onChange={(e) => {
                    const nextType = e.target.value as RewriteRuleType;
                    const nextDraft = createEmptyRewriteRule(nextType);
                    setDraft({ ...nextDraft, id: draft.id, name: draft.name, enabled: draft.enabled, priority: draft.priority, match: draft.match, ...(draft.note ? { note: draft.note } : {}) });
                  }}
                >
                  <MenuItem value="header">{getRewriteTypeLabel("header", t)}</MenuItem>
                  <MenuItem value="query">{getRewriteTypeLabel("query", t)}</MenuItem>
                  <MenuItem value="body">{getRewriteTypeLabel("body", t)}</MenuItem>
                  <MenuItem value="redirect">{getRewriteTypeLabel("redirect", t)}</MenuItem>
                </Select>
              </FormControl>
              <Divider sx={{ my: 0.5 }} />
              <RewriteActionFields rule={draft} onChange={setDraft} />
            </FieldGroup>
          </Paper>
        </Stack>
      )}
    />
  );
}

/* ── RewriteActionFields ──────────────────────────────────────────── */

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
          minRows={4}
          label={t("rulesPage.rewrite.bodyText")}
          value={rule.payload.text}
          onChange={(e) => onChange({ ...rule, payload: { ...rule.payload, text: e.target.value } })}
          sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
        />
      </Stack>
    );
  }

  // redirect
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
