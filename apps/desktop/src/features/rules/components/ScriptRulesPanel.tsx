import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import FileOpenRoundedIcon from "@mui/icons-material/FileOpenRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { coerceAppError, type RuleMatch, type ScriptRule } from "@aiproxy/shared-types";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";

import {
  FieldGroup,
  formatRuleFieldLabel,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleSection,
} from "@/features/rules/components/RulesSharedUi";
import {
  createEmptyScriptRule,
  formatRuleMatch,
  getScriptValidationErrors,
  HTTP_METHODS,
} from "@/features/rules/rules.helpers";
import {
  useDeleteManagedRule,
  useSaveScriptRule,
  useScriptRules,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";
import { readScriptSourceFile } from "@/services/commands";
import { fontFamilies } from "@/themes/fonts";

const HEADER_TEMPLATE = `export function onRequest(ctx) {
  ctx.request.setHeader("x-script", "enabled");
}`;

const MOCK_TEMPLATE = `export function onRequest(ctx) {
  if (!ctx.request.url.includes("/mock")) {
    return;
  }

  ctx.respond({
    status: 200,
    headers: [
      { name: "content-type", value: "application/json" },
    ],
    bodyText: JSON.stringify({ message: "mocked by script" }, null, 2),
    mimeType: "application/json",
  });
}`;

const EXTRACT_TEMPLATE = `export function onResponse(ctx) {
  const data = ctx.response.getJson();
  const token = data?.token;

  if (!token) {
    return;
  }

  ctx.extract("token", token);
  ctx.log.info("extracted token", { token });
}`;

export function ScriptRulesPanel() {
  const { t } = useI18n();
  const { data: rules = [], isError: isRulesError } = useScriptRules();
  const saveMutation = useSaveScriptRule();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<ScriptRule>(createEmptyScriptRule());
  const [validationAttempted, setValidationAttempted] = useState(false);

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .filter((rule) => {
        if (!q) return true;
        return `${rule.name} ${rule.match.urlPattern} ${rule.language}`.toLowerCase().includes(q);
      });
  }, [rules, searchValue]);

  useEffect(() => {
    if (selectedRuleId && rules.some((rule) => rule.id === selectedRuleId)) return;
    const next = filteredRules[0];
    if (next) {
      setSelectedRuleId(next.id);
      setDraft(next);
      setValidationAttempted(false);
      return;
    }
    setSelectedRuleId(undefined);
    setValidationAttempted(false);
  }, [filteredRules, rules, selectedRuleId]);

  function selectRule(rule: ScriptRule) {
    setSelectedRuleId(rule.id);
    setDraft(rule);
    setValidationAttempted(false);
  }

  function handleCreate(template?: "header" | "mock" | "extract") {
    const next = createEmptyScriptRule();
    if (template === "header") {
      next.sourceCode = HEADER_TEMPLATE;
      next.entrypoints = { onRequest: true, onResponse: false };
    }
    if (template === "mock") {
      next.sourceCode = MOCK_TEMPLATE;
      next.entrypoints = { onRequest: true, onResponse: false };
    }
    if (template === "extract") {
      next.sourceCode = EXTRACT_TEMPLATE;
      next.entrypoints = { onRequest: false, onResponse: true };
      next.match.stage = "response";
    }
    setSelectedRuleId(next.id);
    setDraft(next);
    setValidationAttempted(false);
  }

  async function handleImportFile() {
    const selected = await open({
      directory: false,
      filters: [{ name: "Script", extensions: ["js", "mjs", "ts", "mts"] }],
      multiple: false,
      title: t("rulesPage.script.importFile"),
    });

    if (!selected || Array.isArray(selected)) {
      return;
    }

    try {
      const imported = await readScriptSourceFile(selected);
      setDraft((current) => ({
        ...current,
        language: imported.language,
        name: current.name || imported.fileName.replace(/\.[^.]+$/, ""),
        sourceCode: imported.sourceCode,
        sourcePath: imported.path,
        sourceType: "fileImport",
      }));
    } catch {
      // Error handled by command layer.
    }
  }

  function handleSave() {
    if (isRulesError) return;
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
    if (isRulesError) return;
    if (!selectedRuleId || !rules.some((rule) => rule.id === selectedRuleId)) {
      setSelectedRuleId(undefined);
      setDraft(createEmptyScriptRule());
      setValidationAttempted(false);
      return;
    }
    deleteMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "script" },
      {
        onSuccess: () => {
          setSelectedRuleId(undefined);
          setDraft(createEmptyScriptRule());
          setValidationAttempted(false);
        },
      },
    );
  }

  const errors = getScriptValidationErrors(draft, t);
  const saveError = saveMutation.error ? coerceAppError(saveMutation.error).message : undefined;

  return (
    <>
      {isRulesError && (
        <Alert severity="error" sx={{ mb: 1 }}>{t("common.errors.generic")}</Alert>
      )}
      <ManagedRulesWorkbench
      searchPlaceholder={t("rulesPage.script.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          <Button
            size="small"
            variant="outlined"
            disabled={isRulesError}
            startIcon={<AddRoundedIcon />}
            onClick={() => handleCreate()}
          >
            {t("rulesPage.script.createRule")}
          </Button>
          <Button size="small" variant="outlined" disabled={isRulesError} onClick={() => handleCreate("header")}>
            {t("rulesPage.script.templates.header")}
          </Button>
          <Button size="small" variant="outlined" disabled={isRulesError} onClick={() => handleCreate("mock")}>
            {t("rulesPage.script.templates.mock")}
          </Button>
          <Button size="small" variant="outlined" disabled={isRulesError} onClick={() => handleCreate("extract")}>
            {t("rulesPage.script.templates.extract")}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={isRulesError}
            startIcon={<FileOpenRoundedIcon />}
            onClick={() => {
              void handleImportFile();
            }}
          >
            {t("rulesPage.script.importFile")}
          </Button>
        </Stack>
      }
      list={
        <ManagedRuleList
          emptyDescription={t("rulesPage.script.emptyDescription")}
          items={filteredRules.map((rule) => ({
            id: rule.id,
            active: rule.id === selectedRuleId,
            enabled: rule.enabled,
            name: rule.name || t("rulesPage.untitledRule"),
            subtitle: `${formatRuleMatch(rule.match)} • ${rule.language.toUpperCase()}`,
            chipLabel: `${rule.priority}`,
            onClick: () => selectRule(rule),
          }))}
        />
      }
      editor={
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.25}
            alignItems={{ xs: "stretch", md: "center" }}
            sx={{ borderBottom: 1, borderColor: "divider", pb: 1.5 }}
          >
            <TextField
              size="small"
              label={formatRuleFieldLabel(t("rulesPage.editor.ruleName"), "required", t)}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
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
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
            </Stack>
            <TextField
              size="small"
              type="number"
              label={formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t)}
              value={draft.priority}
              onChange={(event) =>
                setDraft({ ...draft, priority: Number(event.target.value) || 0 })
              }
              sx={{ width: { xs: "100%", md: 136 } }}
            />
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteRoundedIcon />}
              onClick={handleDelete}
              disabled={deleteMutation.isPending || isRulesError}
            >
              {t("common.actions.remove")}
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveRoundedIcon />}
              onClick={handleSave}
              disabled={saveMutation.isPending || isRulesError}
            >
              {t("rulesPage.editor.saveRule")}
            </Button>
          </Stack>

          {validationAttempted && errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
              <Stack spacing={0.25}>
                {errors.map((error) => (
                  <Typography key={error} variant="body2">
                    {error}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}

          {saveError && (
            <Alert severity="error" variant="outlined">
              {saveError}
            </Alert>
          )}

          <RuleSection>
            <FieldGroup title={t("rulesPage.editor.matchTitle")}>
              <TextField
                size="small"
                label={formatRuleFieldLabel(t("rulesPage.editor.urlPattern"), "required", t)}
                value={draft.match.urlPattern}
                onChange={(event) =>
                  setDraft({ ...draft, match: { ...draft.match, urlPattern: event.target.value } })
                }
                placeholder={t("rulesPage.editor.urlPatternExample")}
                fullWidth
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                  <Typography color="text.secondary" variant="caption" sx={{ fontWeight: 650 }}>
                    {formatRuleFieldLabel(t("rulesPage.labels.httpMethods"), "optional", t)}
                  </Typography>
                  <Select
                    displayEmpty
                    multiple
                    size="small"
                    value={draft.match.methods}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        match: { ...draft.match, methods: event.target.value as string[] },
                      })
                    }
                    renderValue={(selected) =>
                      selected.length === 0 ? t("rulesPage.allMethods") : selected.join(", ")
                    }
                  >
                    {HTTP_METHODS.map((method) => (
                      <MenuItem key={method} value={method}>
                        {method}
                      </MenuItem>
                    ))}
                  </Select>
                </Stack>
                <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                  <Typography color="text.secondary" variant="caption" sx={{ fontWeight: 650 }}>
                    {formatRuleFieldLabel(t("rulesPage.editor.matchStage"), "required", t)}
                  </Typography>
                  <Select
                    size="small"
                    value={draft.match.stage}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        match: { ...draft.match, stage: event.target.value as RuleMatch["stage"] },
                      })
                    }
                  >
                    <MenuItem value="either">{t("rulesPage.editor.matchStageEither")}</MenuItem>
                    <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                    <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                  </Select>
                </Stack>
                <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                  <Typography color="text.secondary" variant="caption" sx={{ fontWeight: 650 }}>
                    {formatRuleFieldLabel(t("rulesPage.script.language"), "required", t)}
                  </Typography>
                  <Select
                    size="small"
                    value={draft.language}
                    onChange={(event) =>
                      setDraft({ ...draft, language: event.target.value as ScriptRule["language"] })
                    }
                  >
                    <MenuItem value="typescript">TypeScript</MenuItem>
                    <MenuItem value="javascript">JavaScript</MenuItem>
                  </Select>
                </Stack>
              </Stack>
              {draft.sourcePath && (
                <Typography color="text.secondary" variant="caption">
                  {t("rulesPage.script.importedFrom", { path: draft.sourcePath })}
                </Typography>
              )}
            </FieldGroup>
          </RuleSection>

          <RuleSection>
            <FieldGroup title={t("rulesPage.script.sourceTitle")}>
              <TextField
                size="small"
                multiline
                minRows={14}
                label={formatRuleFieldLabel(t("rulesPage.script.sourceCode"), "required", t)}
                value={draft.sourceCode}
                onChange={(event) =>
                  setDraft({ ...draft, sourceCode: event.target.value, sourceType: "inline" })
                }
                sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
              />
            </FieldGroup>
          </RuleSection>
        </Stack>
      }
    />
    </>
  );
}
