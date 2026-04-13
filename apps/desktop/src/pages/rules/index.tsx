import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import RuleFolderRoundedIcon from "@mui/icons-material/RuleFolderRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import type {
  BreakpointRule,
  BreakpointStage,
  MapRule,
  RewriteRule,
  RewriteRuleType,
  RuleMatch,
} from "@pharles/shared-types";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import { useBreakpointRules, useSetBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";
import {
  useDeleteManagedRule,
  useMapRules,
  useRewriteRules,
  useSaveMapRule,
  useSaveRewriteRule,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";
import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const DEFAULT_WORKSPACE_ID = "default";

type RulesTabValue = "breakpoint" | "rewrite" | "mapLocal" | "mapRemote";
type TranslationFn = ReturnType<typeof useI18n>["t"];

function createEmptyRuleMatch(): RuleMatch {
  return {
    urlPattern: "",
    methods: [],
    stage: "either",
  };
}

function createEmptyBreakpointRule(): BreakpointRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    urlPattern: "",
    methods: [],
    stage: "request",
  };
}

function createEmptyRewriteRule(rewriteType: RewriteRuleType = "header"): RewriteRule {
  const base = {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    enabled: true,
    priority: 100,
    match: createEmptyRuleMatch(),
    note: "",
  };

  switch (rewriteType) {
    case "query":
      return {
        ...base,
        rewriteType,
        payload: {
          operation: "set",
          paramName: "",
          value: "",
        },
      };
    case "body":
      return {
        ...base,
        rewriteType,
        payload: {
          contentType: "application/json",
          target: "response",
          text: "",
        },
      };
    case "redirect":
      return {
        ...base,
        rewriteType,
        payload: {
          preservePath: true,
          preserveQuery: true,
          targetUrl: "",
        },
      };
    case "header":
    default:
      return {
        ...base,
        rewriteType: "header",
        payload: {
          headerName: "",
          operation: "set",
          target: "request",
          value: "",
        },
      };
  }
}

function createEmptyMapRule(mode: MapRule["mode"]): MapRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    mode,
    name: "",
    enabled: true,
    priority: 100,
    sourcePattern: "",
    targetValue: "",
    preservePath: true,
    preserveQuery: true,
    note: "",
  };
}

export function RulesPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<RulesTabValue>("rewrite");

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("rulesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("rulesPage.description")}
        </Typography>
      </Stack>

      <SectionCard
        title={t("rulesPage.centerTitle")}
        description={t("rulesPage.centerDescription")}
      >
        <Tabs
          value={tab}
          onChange={(_, value: RulesTabValue) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: "divider", minHeight: 40 }}
        >
          <Tab value="breakpoint" label={t("rulesPage.tabs.breakpoint")} sx={{ minHeight: 40 }} />
          <Tab value="rewrite" label={t("rulesPage.tabs.rewrite")} sx={{ minHeight: 40 }} />
          <Tab value="mapLocal" label={t("rulesPage.tabs.mapLocal")} sx={{ minHeight: 40 }} />
          <Tab value="mapRemote" label={t("rulesPage.tabs.mapRemote")} sx={{ minHeight: 40 }} />
        </Tabs>

        <Box sx={{ mt: 3 }}>
          {tab === "breakpoint" ? <BreakpointRulesPanel /> : null}
          {tab === "rewrite" ? <RewriteRulesPanel /> : null}
          {tab === "mapLocal" ? <MapRulesPanel mode="local" /> : null}
          {tab === "mapRemote" ? <MapRulesPanel mode="remote" /> : null}
        </Box>
      </SectionCard>
    </Stack>
  );
}

function BreakpointRulesPanel() {
  const { t } = useI18n();
  const { data: rules = [] } = useBreakpointRules();
  const setRulesMutation = useSetBreakpointRules();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<BreakpointRule>(createEmptyBreakpointRule());

  function handleSave() {
    setRulesMutation.mutate([...rules, draft]);
    setDialogOpen(false);
    setDraft(createEmptyBreakpointRule());
  }

  function handleToggle(id: string) {
    setRulesMutation.mutate(rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
  }

  function handleDelete(id: string) {
    setRulesMutation.mutate(rules.filter((rule) => rule.id !== id));
  }

  function handleAddCatchAll(stage: BreakpointStage) {
    const catchAll: BreakpointRule = {
      id: crypto.randomUUID(),
      enabled: true,
      urlPattern: "*",
      methods: [],
      stage,
    };

    setRulesMutation.mutate([...rules, catchAll]);
  }

  const hasRequestCatchAll = rules.some((rule) => rule.enabled && rule.urlPattern === "*" && rule.stage === "request" && rule.methods.length === 0);
  const hasResponseCatchAll = rules.some((rule) => rule.enabled && rule.urlPattern === "*" && rule.stage === "response" && rule.methods.length === 0);

  return (
    <Stack spacing={3}>
      <SectionCard
        title={t("rulesPage.quickBreakpointTitle")}
        description={t("rulesPage.quickBreakpointDescription")}
      >
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <Button
            variant="outlined"
            size="small"
            disabled={hasRequestCatchAll}
            onClick={() => handleAddCatchAll("request")}
          >
            {t("rulesPage.breakOnAllRequests")}
          </Button>
          <Button
            variant="outlined"
            size="small"
            disabled={hasResponseCatchAll}
            onClick={() => handleAddCatchAll("response")}
          >
            {t("rulesPage.breakOnAllResponses")}
          </Button>
        </Stack>
      </SectionCard>

      <SectionCard
        title={t("rulesPage.breakpointRulesTitle")}
        description={t("rulesPage.breakpointRulesDescription")}
        toolbar={(
          <Button
            variant="contained"
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={() => {
              setDraft(createEmptyBreakpointRule());
              setDialogOpen(true);
            }}
          >
            {t("rulesPage.addRule")}
          </Button>
        )}
      >
        {rules.length === 0 ? (
          <Typography color="text.secondary" variant="body2">
            {t("rulesPage.empty")}
          </Typography>
        ) : (
          <Stack spacing={1}>
            {rules.map((rule) => (
              <Paper
                key={rule.id}
                elevation={0}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 2,
                  boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
                  p: 1.5,
                }}
              >
                <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} justifyContent="space-between">
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Switch size="small" checked={rule.enabled} onChange={() => handleToggle(rule.id)} />
                      <Typography sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}>
                        {rule.urlPattern || "*"}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={rule.stage === "request" ? "info" : "secondary"}
                        label={rule.stage === "request" ? t("rulesPage.stages.request") : t("rulesPage.stages.response")}
                      />
                    </Stack>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                      {rule.methods.length === 0 ? (
                        <Chip label={t("rulesPage.labels.all")} size="small" variant="outlined" />
                      ) : (
                        rule.methods.map((method) => <Chip key={method} label={method} size="small" />)
                      )}
                    </Stack>
                  </Stack>
                  <IconButton color="error" onClick={() => handleDelete(rule.id)}>
                    <DeleteRoundedIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </SectionCard>

      <Dialog fullWidth maxWidth="sm" onClose={() => setDialogOpen(false)} open={dialogOpen}>
        <DialogTitle>{t("rulesPage.addDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <OutlinedInput
              placeholder={t("rulesPage.urlPatternPlaceholder")}
              value={draft.urlPattern}
              onChange={(event) => setDraft({ ...draft, urlPattern: event.target.value })}
              fullWidth
              sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.httpMethods")}</InputLabel>
              <Select
                multiple
                value={draft.methods}
                onChange={(event) => setDraft({ ...draft, methods: event.target.value as string[] })}
                input={<OutlinedInput label={t("rulesPage.labels.httpMethods")} />}
                renderValue={(selected) => (selected.length === 0 ? t("rulesPage.allMethods") : selected.join(", "))}
              >
                {HTTP_METHODS.map((method) => (
                  <MenuItem key={method} value={method}>
                    {method}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.stage")}</InputLabel>
              <Select
                value={draft.stage}
                label={t("rulesPage.labels.stage")}
                onChange={(event) => setDraft({ ...draft, stage: event.target.value as BreakpointStage })}
              >
                <MenuItem value="request">{t("rulesPage.requestStageOption")}</MenuItem>
                <MenuItem value="response">{t("rulesPage.responseStageOption")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)}>{t("common.actions.cancel")}</Button>
          <Button variant="contained" onClick={handleSave} disabled={setRulesMutation.isPending}>
            {t("rulesPage.addRule")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function RewriteRulesPanel() {
  const { t } = useI18n();
  const { data: rules = [] } = useRewriteRules();
  const saveRewriteRuleMutation = useSaveRewriteRule();
  const deleteManagedRuleMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<RewriteRule>(createEmptyRewriteRule("header"));

  const filteredRules = useMemo(() => {
    const normalizedQuery = searchValue.trim().toLowerCase();

    return [...rules]
      .sort((left, right) => right.priority - left.priority)
      .filter((rule) => {
        if (!normalizedQuery) {
          return true;
        }

        const haystack = `${rule.name} ${rule.match.urlPattern} ${rule.rewriteType}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
  }, [rules, searchValue]);

  useEffect(() => {
    if (selectedRuleId && rules.some((rule) => rule.id === selectedRuleId)) {
      return;
    }

    const nextRule = filteredRules[0];

    if (nextRule) {
      setSelectedRuleId(nextRule.id);
      setDraft(nextRule);
      return;
    }

    setSelectedRuleId(undefined);
  }, [filteredRules, rules, selectedRuleId]);

  function selectRule(rule: RewriteRule) {
    setSelectedRuleId(rule.id);
    setDraft(rule);
  }

  function handleCreateRule(rewriteType: RewriteRuleType) {
    const nextDraft = createEmptyRewriteRule(rewriteType);
    setSelectedRuleId(nextDraft.id);
    setDraft(nextDraft);
  }

  function handleSave() {
    saveRewriteRuleMutation.mutate(draft, {
      onSuccess: (savedRule) => {
        setSelectedRuleId(savedRule.id);
        setDraft(savedRule);
      },
    });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((rule) => rule.id === selectedRuleId)) {
      setDraft(createEmptyRewriteRule());
      setSelectedRuleId(undefined);
      return;
    }

    deleteManagedRuleMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "rewrite" },
      {
        onSuccess: () => {
          setSelectedRuleId(undefined);
          setDraft(createEmptyRewriteRule());
        },
      },
    );
  }

  const validationErrors = getRewriteValidationErrors(draft, t);

  return (
    <ManagedRulesWorkbench
      title={t("rulesPage.rewrite.title")}
      description={t("rulesPage.rewrite.description")}
      searchPlaceholder={t("rulesPage.rewrite.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={(
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="contained" startIcon={<EditNoteRoundedIcon />} onClick={() => handleCreateRule("header")}>
            {t("rulesPage.rewrite.quickCreateHeader")}
          </Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("query")}>
            {t("rulesPage.rewrite.quickCreateQuery")}
          </Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("body")}>
            {t("rulesPage.rewrite.quickCreateBody")}
          </Button>
          <Button size="small" variant="outlined" onClick={() => handleCreateRule("redirect")}>
            {t("rulesPage.rewrite.quickCreateRedirect")}
          </Button>
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
            chipLabel: `${t("rulesPage.priority")} ${rule.priority}`,
            onClick: () => selectRule(rule),
          }))}
        />
      )}
      editor={(
        <Stack spacing={3}>
          <SectionCard
            title={t("rulesPage.editor.basicTitle")}
            description={t("rulesPage.editor.basicDescription")}
          >
            <Stack spacing={2}>
              <TextField
                size="small"
                label={t("rulesPage.editor.ruleName")}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <FormControl size="small" sx={{ minWidth: 200 }}>
                  <InputLabel>{t("rulesPage.editor.ruleType")}</InputLabel>
                  <Select
                    label={t("rulesPage.editor.ruleType")}
                    value={draft.rewriteType}
                    onChange={(event) => {
                      const nextType = event.target.value as RewriteRuleType;
                      const nextDraft = createEmptyRewriteRule(nextType);
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
                  >
                    <MenuItem value="header">{getRewriteTypeLabel("header", t)}</MenuItem>
                    <MenuItem value="query">{getRewriteTypeLabel("query", t)}</MenuItem>
                    <MenuItem value="body">{getRewriteTypeLabel("body", t)}</MenuItem>
                    <MenuItem value="redirect">{getRewriteTypeLabel("redirect", t)}</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  size="small"
                  type="number"
                  label={t("rulesPage.editor.priority")}
                  value={draft.priority}
                  onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) || 0 })}
                  sx={{ width: 160 }}
                />
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                  <Typography variant="body2">{t("rulesPage.editor.enabled")}</Typography>
                  <Switch
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                </Stack>
              </Stack>
              <TextField
                size="small"
                multiline
                minRows={2}
                label={t("rulesPage.editor.note")}
                value={draft.note ?? ""}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ArrowUpwardRoundedIcon />}
                  onClick={() => setDraft({ ...draft, priority: draft.priority + 10 })}
                >
                  {t("rulesPage.editor.promote")}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ArrowDownwardRoundedIcon />}
                  onClick={() => setDraft({ ...draft, priority: Math.max(0, draft.priority - 10) })}
                >
                  {t("rulesPage.editor.demote")}
                </Button>
              </Stack>
            </Stack>
          </SectionCard>

          <MatchConditionsCard
            match={draft.match}
            onChange={(match) => setDraft({ ...draft, match })}
          />

          <RewriteActionEditor
            rule={draft}
            onChange={setDraft}
          />

          <RulePreviewCard
            errors={validationErrors}
            lines={buildRewritePreviewLines(draft, t)}
          />

          <Stack direction="row" justifyContent="space-between" spacing={2}>
            <Button
              color="error"
              variant="outlined"
              startIcon={<DeleteRoundedIcon />}
              onClick={handleDelete}
              disabled={deleteManagedRuleMutation.isPending}
            >
              {t("common.actions.remove")}
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={validationErrors.length > 0 || saveRewriteRuleMutation.isPending}
            >
              {t("rulesPage.editor.saveRule")}
            </Button>
          </Stack>
        </Stack>
      )}
    />
  );
}

function MapRulesPanel({ mode }: { mode: MapRule["mode"] }) {
  const { t } = useI18n();
  const { data: rules = [] } = useMapRules(mode);
  const saveMapRuleMutation = useSaveMapRule();
  const deleteManagedRuleMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<MapRule>(createEmptyMapRule(mode));

  const filteredRules = useMemo(() => {
    const normalizedQuery = searchValue.trim().toLowerCase();

    return [...rules]
      .sort((left, right) => right.priority - left.priority)
      .filter((rule) => {
        if (!normalizedQuery) {
          return true;
        }

        const haystack = `${rule.name} ${rule.sourcePattern} ${rule.targetValue}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
  }, [rules, searchValue]);

  useEffect(() => {
    if (draft.mode !== mode) {
      setDraft(createEmptyMapRule(mode));
      setSelectedRuleId(undefined);
    }
  }, [draft.mode, mode]);

  useEffect(() => {
    if (selectedRuleId && rules.some((rule) => rule.id === selectedRuleId)) {
      return;
    }

    const nextRule = filteredRules[0];

    if (nextRule) {
      setSelectedRuleId(nextRule.id);
      setDraft(nextRule);
      return;
    }

    setSelectedRuleId(undefined);
  }, [filteredRules, rules, selectedRuleId]);

  function selectRule(rule: MapRule) {
    setSelectedRuleId(rule.id);
    setDraft(rule);
  }

  function handleCreateRule() {
    const nextDraft = createEmptyMapRule(mode);
    setSelectedRuleId(nextDraft.id);
    setDraft(nextDraft);
  }

  function handleSave() {
    saveMapRuleMutation.mutate(draft, {
      onSuccess: (savedRule) => {
        setSelectedRuleId(savedRule.id);
        setDraft(savedRule);
      },
    });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((rule) => rule.id === selectedRuleId)) {
      setDraft(createEmptyMapRule(mode));
      setSelectedRuleId(undefined);
      return;
    }

    deleteManagedRuleMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "map" },
      {
        onSuccess: () => {
          setSelectedRuleId(undefined);
          setDraft(createEmptyMapRule(mode));
        },
      },
    );
  }

  const validationErrors = getMapValidationErrors(draft, t);

  return (
    <ManagedRulesWorkbench
      title={mode === "local" ? t("rulesPage.mapLocal.title") : t("rulesPage.mapRemote.title")}
      description={mode === "local" ? t("rulesPage.mapLocal.description") : t("rulesPage.mapRemote.description")}
      searchPlaceholder={mode === "local" ? t("rulesPage.mapLocal.searchPlaceholder") : t("rulesPage.mapRemote.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={(
        <Button size="small" variant="contained" startIcon={<RuleFolderRoundedIcon />} onClick={handleCreateRule}>
          {mode === "local" ? t("rulesPage.mapLocal.createRule") : t("rulesPage.mapRemote.createRule")}
        </Button>
      )}
      list={(
        <ManagedRuleList
          emptyDescription={mode === "local" ? t("rulesPage.mapLocal.emptyDescription") : t("rulesPage.mapRemote.emptyDescription")}
          items={filteredRules.map((rule) => ({
            id: rule.id,
            active: rule.id === selectedRuleId,
            enabled: rule.enabled,
            name: rule.name || t("rulesPage.untitledRule"),
            subtitle: `${rule.sourcePattern || "*"} → ${rule.targetValue || t("rulesPage.notConfigured")}`,
            chipLabel: `${t("rulesPage.priority")} ${rule.priority}`,
            onClick: () => selectRule(rule),
          }))}
        />
      )}
      editor={(
        <Stack spacing={3}>
          <SectionCard
            title={t("rulesPage.editor.basicTitle")}
            description={t("rulesPage.editor.basicDescription")}
          >
            <Stack spacing={2}>
              <TextField
                size="small"
                label={t("rulesPage.editor.ruleName")}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  size="small"
                  type="number"
                  label={t("rulesPage.editor.priority")}
                  value={draft.priority}
                  onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) || 0 })}
                  sx={{ width: 160 }}
                />
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                  <Typography variant="body2">{t("rulesPage.editor.enabled")}</Typography>
                  <Switch
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                </Stack>
              </Stack>
              <TextField
                size="small"
                multiline
                minRows={2}
                label={t("rulesPage.editor.note")}
                value={draft.note ?? ""}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
            </Stack>
          </SectionCard>

          <SectionCard
            title={t("rulesPage.mapEditor.matchTitle")}
            description={t("rulesPage.mapEditor.matchDescription")}
          >
            <Stack spacing={2}>
              <TextField
                size="small"
                label={t("rulesPage.mapEditor.sourcePattern")}
                value={draft.sourcePattern}
                onChange={(event) => setDraft({ ...draft, sourcePattern: event.target.value })}
                placeholder="https://example.com/assets/*"
              />
              <TextField
                size="small"
                label={mode === "local" ? t("rulesPage.mapLocal.targetPath") : t("rulesPage.mapRemote.targetUrl")}
                value={draft.targetValue}
                onChange={(event) => setDraft({ ...draft, targetValue: event.target.value })}
                placeholder={mode === "local" ? "/Users/you/project/dist" : "https://staging.example.com"}
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                  <Typography variant="body2">{t("rulesPage.mapEditor.preservePath")}</Typography>
                  <Switch
                    checked={draft.preservePath}
                    onChange={(event) => setDraft({ ...draft, preservePath: event.target.checked })}
                  />
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                  <Typography variant="body2">{t("rulesPage.mapEditor.preserveQuery")}</Typography>
                  <Switch
                    checked={draft.preserveQuery}
                    onChange={(event) => setDraft({ ...draft, preserveQuery: event.target.checked })}
                  />
                </Stack>
              </Stack>
            </Stack>
          </SectionCard>

          <RulePreviewCard
            errors={validationErrors}
            lines={[
              mode === "local"
                ? t("rulesPage.mapLocal.previewLineOne", { source: draft.sourcePattern || "*", target: draft.targetValue || t("rulesPage.notConfigured") })
                : t("rulesPage.mapRemote.previewLineOne", { source: draft.sourcePattern || "*", target: draft.targetValue || t("rulesPage.notConfigured") }),
              t("rulesPage.mapEditor.previewLineTwo", {
                pathState: draft.preservePath ? t("rulesPage.mapEditor.on") : t("rulesPage.mapEditor.off"),
                queryState: draft.preserveQuery ? t("rulesPage.mapEditor.on") : t("rulesPage.mapEditor.off"),
              }),
            ]}
          />

          <Stack direction="row" justifyContent="space-between" spacing={2}>
            <Button
              color="error"
              variant="outlined"
              startIcon={<DeleteRoundedIcon />}
              onClick={handleDelete}
              disabled={deleteManagedRuleMutation.isPending}
            >
              {t("common.actions.remove")}
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={validationErrors.length > 0 || saveMapRuleMutation.isPending}
            >
              {t("rulesPage.editor.saveRule")}
            </Button>
          </Stack>
        </Stack>
      )}
    />
  );
}

function ManagedRulesWorkbench(props: {
  createActions: ReactNode;
  description: string;
  editor: ReactNode;
  list: ReactNode;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchValue: string;
  title: string;
}) {
  const { createActions, description, editor, list, onSearchChange, searchPlaceholder, searchValue, title } = props;

  return (
    <Box
      sx={{
        display: "grid",
        gap: 3,
        gridTemplateColumns: {
          lg: "minmax(320px, 360px) minmax(0, 1fr)",
          xs: "1fr",
        },
      }}
    >
      <Stack spacing={2}>
        <SectionCard title={title} description={description}>
          <Stack spacing={2}>
            {createActions}
            <OutlinedInput
              fullWidth
              size="small"
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </Stack>
        </SectionCard>
        {list}
      </Stack>

      {editor}
    </Box>
  );
}

function ManagedRuleList(props: {
  emptyDescription: string;
  items: Array<{
    active: boolean;
    chipLabel: string;
    enabled: boolean;
    id: string;
    name: string;
    onClick: () => void;
    subtitle: string;
  }>;
}) {
  const { t } = useI18n();
  const { emptyDescription, items } = props;

  if (items.length === 0) {
    return (
      <SectionCard title="Rules" description={emptyDescription}>
        <Alert severity="info" variant="outlined">
          {emptyDescription}
        </Alert>
      </SectionCard>
    );
  }

  return (
    <Paper
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 3,
        boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
        overflow: "hidden",
      }}
    >
      <List disablePadding>
        {items.map((item, index) => (
          <Box key={item.id}>
            <ListItemButton
              selected={item.active}
              onClick={item.onClick}
              sx={{
                alignItems: "flex-start",
                px: 2,
                py: 1.5,
                transition: "background-color 140ms ease, box-shadow 140ms ease",
                "&:hover": {
                  boxShadow: (theme) => getHoverShadow(theme.palette.mode),
                },
              }}
            >
              <ListItemText
                primary={(
                  <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center">
                    <Typography sx={{ fontWeight: 600 }}>{item.name}</Typography>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                      {!item.enabled ? <Chip size="small" label={t("rulesPage.off")} variant="outlined" /> : null}
                      <Chip size="small" label={item.chipLabel} />
                    </Stack>
                  </Stack>
                )}
                secondary={(
                  <Typography sx={{ mt: 0.75 }} variant="body2" color="text.secondary">
                    {item.subtitle}
                  </Typography>
                )}
              />
            </ListItemButton>
            {index < items.length - 1 ? <Divider /> : null}
          </Box>
        ))}
      </List>
    </Paper>
  );
}

function MatchConditionsCard(props: {
  match: RuleMatch;
  onChange: (match: RuleMatch) => void;
}) {
  const { t } = useI18n();
  const { match, onChange } = props;

  return (
    <SectionCard
      title={t("rulesPage.editor.matchTitle")}
      description={t("rulesPage.editor.matchDescription")}
    >
      <Stack spacing={2}>
        <TextField
          size="small"
          label={t("rulesPage.editor.urlPattern")}
          value={match.urlPattern}
          onChange={(event) => onChange({ ...match, urlPattern: event.target.value })}
          placeholder="api.example.com/v1/*"
        />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <FormControl size="small" fullWidth>
            <InputLabel>{t("rulesPage.labels.httpMethods")}</InputLabel>
            <Select
              multiple
              value={match.methods}
              onChange={(event) => onChange({ ...match, methods: event.target.value as string[] })}
              input={<OutlinedInput label={t("rulesPage.labels.httpMethods")} />}
              renderValue={(selected) => (selected.length === 0 ? t("rulesPage.allMethods") : selected.join(", "))}
            >
              {HTTP_METHODS.map((method) => (
                <MenuItem key={method} value={method}>
                  {method}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>{t("rulesPage.editor.matchStage")}</InputLabel>
            <Select
              label={t("rulesPage.editor.matchStage")}
              value={match.stage}
              onChange={(event) => onChange({ ...match, stage: event.target.value as RuleMatch["stage"] })}
            >
              <MenuItem value="either">{t("rulesPage.editor.matchStageEither")}</MenuItem>
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Stack>
    </SectionCard>
  );
}

function RewriteActionEditor(props: {
  onChange: (rule: RewriteRule) => void;
  rule: RewriteRule;
}) {
  const { t } = useI18n();
  const { onChange, rule } = props;

  return (
    <SectionCard
      title={t("rulesPage.editor.actionTitle")}
      description={t("rulesPage.editor.actionDescription")}
    >
      <Stack spacing={2}>
        {rule.rewriteType === "header" ? (
          <>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <FormControl size="small" fullWidth>
                <InputLabel>{t("rulesPage.rewrite.headerTarget")}</InputLabel>
                <Select
                  label={t("rulesPage.rewrite.headerTarget")}
                  value={rule.payload.target}
                  onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, target: event.target.value as "request" | "response" } })}
                >
                  <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                  <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>{t("rulesPage.rewrite.operation")}</InputLabel>
                <Select
                  label={t("rulesPage.rewrite.operation")}
                  value={rule.payload.operation}
                  onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, operation: event.target.value as "set" | "remove" } })}
                >
                  <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
                  <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <TextField
              size="small"
              label={t("rulesPage.rewrite.headerName")}
              value={rule.payload.headerName}
              onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, headerName: event.target.value } })}
              placeholder="x-debug-mode"
            />
            {rule.payload.operation === "set" ? (
              <TextField
                size="small"
                label={t("rulesPage.rewrite.headerValue")}
                value={rule.payload.value ?? ""}
                onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, value: event.target.value } })}
                placeholder="true"
              />
            ) : null}
          </>
        ) : null}

        {rule.rewriteType === "query" ? (
          <>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.rewrite.operation")}</InputLabel>
              <Select
                label={t("rulesPage.rewrite.operation")}
                value={rule.payload.operation}
                onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, operation: event.target.value as "set" | "remove" } })}
              >
                <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
                <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
              </Select>
            </FormControl>
            <TextField
              size="small"
              label={t("rulesPage.rewrite.queryName")}
              value={rule.payload.paramName}
              onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, paramName: event.target.value } })}
              placeholder="env"
            />
            {rule.payload.operation === "set" ? (
              <TextField
                size="small"
                label={t("rulesPage.rewrite.queryValue")}
                value={rule.payload.value ?? ""}
                onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, value: event.target.value } })}
                placeholder="staging"
              />
            ) : null}
          </>
        ) : null}

        {rule.rewriteType === "body" ? (
          <>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <FormControl size="small" fullWidth>
                <InputLabel>{t("rulesPage.rewrite.bodyTarget")}</InputLabel>
                <Select
                  label={t("rulesPage.rewrite.bodyTarget")}
                  value={rule.payload.target}
                  onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, target: event.target.value as "request" | "response" } })}
                >
                  <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                  <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                </Select>
              </FormControl>
              <TextField
                size="small"
                label={t("rulesPage.rewrite.contentType")}
                value={rule.payload.contentType}
                onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, contentType: event.target.value } })}
              />
            </Stack>
            <TextField
              size="small"
              multiline
              minRows={6}
              label={t("rulesPage.rewrite.bodyText")}
              value={rule.payload.text}
              onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, text: event.target.value } })}
              sx={{
                "& .MuiInputBase-input": {
                  fontFamily: "JetBrains Mono, Consolas, monospace",
                  fontSize: 13,
                },
              }}
            />
          </>
        ) : null}

        {rule.rewriteType === "redirect" ? (
          <>
            <TextField
              size="small"
              label={t("rulesPage.rewrite.redirectTarget")}
              value={rule.payload.targetUrl}
              onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, targetUrl: event.target.value } })}
              placeholder="https://staging.example.com"
            />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                <Typography variant="body2">{t("rulesPage.rewrite.preservePath")}</Typography>
                <Switch
                  checked={rule.payload.preservePath}
                  onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, preservePath: event.target.checked } })}
                />
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 40 }}>
                <Typography variant="body2">{t("rulesPage.rewrite.preserveQuery")}</Typography>
                <Switch
                  checked={rule.payload.preserveQuery}
                  onChange={(event) => onChange({ ...rule, payload: { ...rule.payload, preserveQuery: event.target.checked } })}
                />
              </Stack>
            </Stack>
          </>
        ) : null}
      </Stack>
    </SectionCard>
  );
}

function RulePreviewCard(props: {
  errors: string[];
  lines: string[];
}) {
  const { t } = useI18n();
  const { errors, lines } = props;

  return (
    <SectionCard
      title={t("rulesPage.editor.previewTitle")}
      description={t("rulesPage.editor.previewDescription")}
    >
      <Stack spacing={1.5}>
        {errors.length > 0 ? (
          <Alert severity="warning" variant="outlined">
            <Stack spacing={0.5}>
              {errors.map((error) => (
                <Typography key={error} variant="body2">
                  {error}
                </Typography>
              ))}
            </Stack>
          </Alert>
        ) : (
          <Alert severity="success" variant="outlined">
            {t("rulesPage.editor.ready")}
          </Alert>
        )}
        <Stack spacing={0.75}>
          {lines.map((line) => (
            <Typography key={line} color="text.secondary" variant="body2">
              {line}
            </Typography>
          ))}
        </Stack>
      </Stack>
    </SectionCard>
  );
}

function getRewriteValidationErrors(rule: RewriteRule, t: TranslationFn): string[] {
  const errors: string[] = [];

  if (!rule.name.trim()) {
    errors.push(t("rulesPage.validation.ruleNameRequired"));
  }

  if (!rule.match.urlPattern.trim()) {
    errors.push(t("rulesPage.validation.urlPatternRequired"));
  }

  if (rule.rewriteType === "header") {
    if (!rule.payload.headerName.trim()) {
      errors.push(t("rulesPage.validation.headerNameRequired"));
    }

    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim()) {
      errors.push(t("rulesPage.validation.headerValueRequired"));
    }
  }

  if (rule.rewriteType === "query") {
    if (!rule.payload.paramName.trim()) {
      errors.push(t("rulesPage.validation.queryNameRequired"));
    }

    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim()) {
      errors.push(t("rulesPage.validation.queryValueRequired"));
    }
  }

  if (rule.rewriteType === "body" && !rule.payload.text.trim()) {
    errors.push(t("rulesPage.validation.bodyTextRequired"));
  }

  if (rule.rewriteType === "redirect" && !rule.payload.targetUrl.trim()) {
    errors.push(t("rulesPage.validation.redirectTargetRequired"));
  }

  return errors;
}

function getMapValidationErrors(rule: MapRule, t: TranslationFn): string[] {
  const errors: string[] = [];

  if (!rule.name.trim()) {
    errors.push(t("rulesPage.validation.ruleNameRequired"));
  }

  if (!rule.sourcePattern.trim()) {
    errors.push(t("rulesPage.validation.mapSourceRequired"));
  }

  if (!rule.targetValue.trim()) {
    errors.push(
      rule.mode === "local"
        ? t("rulesPage.validation.localTargetRequired")
        : t("rulesPage.validation.remoteTargetRequired"),
    );
  }

  return errors;
}

function buildRewritePreviewLines(rule: RewriteRule, t: TranslationFn): string[] {
  const baseLine = t("rulesPage.preview.matchLine", {
    methods: rule.match.methods.length === 0 ? t("rulesPage.allMethods") : rule.match.methods.join(", "),
    stage:
      rule.match.stage === "either"
        ? t("rulesPage.editor.matchStageEither")
        : rule.match.stage === "request"
          ? t("rulesPage.stages.request")
          : t("rulesPage.stages.response"),
    urlPattern: rule.match.urlPattern || "*",
  });

  if (rule.rewriteType === "header") {
    return [
      baseLine,
      t("rulesPage.rewrite.previewHeader", {
        name: rule.payload.headerName || t("rulesPage.notConfigured"),
        operation:
          rule.payload.operation === "set"
            ? t("rulesPage.rewrite.operations.set")
            : t("rulesPage.rewrite.operations.remove"),
        target: rule.payload.target === "request" ? t("rulesPage.stages.request") : t("rulesPage.stages.response"),
      }),
    ];
  }

  if (rule.rewriteType === "query") {
    return [
      baseLine,
      t("rulesPage.rewrite.previewQuery", {
        name: rule.payload.paramName || t("rulesPage.notConfigured"),
        operation:
          rule.payload.operation === "set"
            ? t("rulesPage.rewrite.operations.set")
            : t("rulesPage.rewrite.operations.remove"),
      }),
    ];
  }

  if (rule.rewriteType === "body") {
    return [
      baseLine,
      t("rulesPage.rewrite.previewBody", {
        contentType: rule.payload.contentType,
        target: rule.payload.target === "request" ? t("rulesPage.stages.request") : t("rulesPage.stages.response"),
      }),
    ];
  }

  return [
    baseLine,
    t("rulesPage.rewrite.previewRedirect", {
      target: rule.payload.targetUrl || t("rulesPage.notConfigured"),
    }),
  ];
}

function formatRuleMatch(match: RuleMatch): string {
  const methods = match.methods.length === 0 ? "ALL" : match.methods.join(", ");
  return `${methods} • ${match.urlPattern || "*"}`;
}

function getRewriteTypeLabel(rewriteType: RewriteRuleType, t: TranslationFn) {
  switch (rewriteType) {
    case "header":
      return t("rulesPage.rewrite.types.header");
    case "query":
      return t("rulesPage.rewrite.types.query");
    case "body":
      return t("rulesPage.rewrite.types.body");
    case "redirect":
      return t("rulesPage.rewrite.types.redirect");
  }
}
