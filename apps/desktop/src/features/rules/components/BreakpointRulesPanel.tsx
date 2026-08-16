import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import {
  Alert,
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
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { BreakpointRule, BreakpointStage, MatchType } from "@aiproxy/shared-types";
import { useState } from "react";

import {
  useBreakpointRules,
  useSetBreakpointRules,
} from "@/features/breakpoints/use-breakpoint-rules";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { formatRuleFieldLabel } from "@/features/rules/components/RulesSharedUi";
import {
  createCatchAllRule,
  createEmptyBreakpointRule,
  HTTP_METHODS,
} from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function BreakpointRulesPanel() {
  const { t } = useI18n();
  const { data: rules = [], isError: isRulesError } = useBreakpointRules();
  const setRulesMutation = useSetBreakpointRules();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Destructive delete is confirmed first; the target rule drives the dialog copy.
  const [deleteTarget, setDeleteTarget] = useState<BreakpointRule | null>(null);
  const [draft, setDraft] = useState<BreakpointRule>(createEmptyBreakpointRule());
  const [validationAttempted, setValidationAttempted] = useState(false);

  function handleSave() {
    setValidationAttempted(true);
    if (errors.length > 0) return;
    setRulesMutation.mutate([...rules, draft]);
    setDialogOpen(false);
    setDraft(createEmptyBreakpointRule());
    setValidationAttempted(false);
  }

  function handleToggle(id: string) {
    setRulesMutation.mutate(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function handleDelete(rule: BreakpointRule) {
    setDeleteTarget(rule);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    setRulesMutation.mutate(rules.filter((r) => r.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  function handleAddCatchAll(stage: BreakpointStage) {
    setRulesMutation.mutate([...rules, createCatchAllRule(stage)]);
  }

  function handleDialogClose() {
    setDialogOpen(false);
    setValidationAttempted(false);
  }

  const hasRequestCatchAll = rules.some(
    (r) => r.enabled && r.urlPattern === "*" && r.stage === "request" && r.methods.length === 0,
  );
  const hasResponseCatchAll = rules.some(
    (r) => r.enabled && r.urlPattern === "*" && r.stage === "response" && r.methods.length === 0,
  );
  const errors: string[] = [];
  if (!draft.urlPattern.trim()) errors.push(t("rulesPage.validation.urlPatternRequired"));
  if (draft.matchType === "regex" && draft.urlPattern.trim()) {
    try {
      new RegExp(draft.urlPattern.trim());
    } catch {
      errors.push(t("rulesPage.validation.regexPatternInvalid"));
    }
  }
  const urlPatternLabel = formatRuleFieldLabel(t("rulesPage.editor.urlPattern"), "required", t);
  const matchTypeLabel = t("rulesPage.editor.matchType");
  const methodsLabel = formatRuleFieldLabel(t("rulesPage.labels.httpMethods"), "optional", t);
  const stageLabel = formatRuleFieldLabel(t("rulesPage.labels.stage"), "required", t);
  const matchTypes: { value: MatchType; label: string }[] = [
    { value: "contains", label: t("rulesPage.editor.matchTypes.contains") },
    { value: "wildcard", label: t("rulesPage.editor.matchTypes.wildcard") },
    { value: "exact", label: t("rulesPage.editor.matchTypes.exact") },
    { value: "regex", label: t("rulesPage.editor.matchTypes.regex") },
  ];

  return (
    <Stack spacing={2}>
      {isRulesError && <Alert severity="error">{t("common.errors.generic")}</Alert>}
      <Paper
        elevation={0}
        sx={{
          bgcolor: (theme) =>
            alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.78 : 0.92),
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          p: 1.5,
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{
            alignItems: { xs: "stretch", md: "center" },
          }}
        >
          <Stack spacing={0.25} sx={{ flex: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 650 }}>
              {t("rulesPage.quickBreakpointTitle")}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("rulesPage.quickBreakpointDescription")}
            </Typography>
          </Stack>
          <Stack
            direction="row"
            spacing={0.75}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            <Button
              size="small"
              variant="outlined"
              disabled={hasRequestCatchAll || isRulesError}
              onClick={() => handleAddCatchAll("request")}
            >
              {t("rulesPage.breakOnAllRequests")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={hasResponseCatchAll || isRulesError}
              onClick={() => handleAddCatchAll("response")}
            >
              {t("rulesPage.breakOnAllResponses")}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={isRulesError}
              startIcon={<AddRoundedIcon />}
              onClick={() => {
                setDraft(createEmptyBreakpointRule());
                setValidationAttempted(false);
                setDialogOpen(true);
              }}
            >
              {t("rulesPage.addRule")}
            </Button>
          </Stack>
        </Stack>
      </Paper>
      {rules.length === 0 ? (
        <Paper
          elevation={0}
          sx={{
            alignItems: "center",
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            color: "text.secondary",
            display: "flex",
            justifyContent: "center",
            minHeight: 260,
            px: 2,
            textAlign: "center",
          }}
        >
          <Typography variant="body2">{t("rulesPage.empty")}</Typography>
        </Paper>
      ) : (
        <Paper
          elevation={0}
          sx={{
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <List disablePadding dense>
            {rules.map((rule) => (
              <Stack
                key={rule.id}
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: "center",

                  bgcolor: rule.enabled
                    ? "transparent"
                    : (theme) =>
                        alpha(
                          theme.palette.text.primary,
                          theme.palette.mode === "dark" ? 0.025 : 0.02,
                        ),

                  px: 2,
                  py: 1,
                  "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
                }}
              >
                <Switch
                  size="small"
                  checked={rule.enabled}
                  onChange={() => handleToggle(rule.id)}
                />
                <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 13, flex: 1 }} noWrap>
                  {rule.urlPattern || "*"}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={rule.stage === "request" ? "info" : "secondary"}
                  label={
                    rule.stage === "request"
                      ? t("rulesPage.stages.request")
                      : t("rulesPage.stages.response")
                  }
                />
                {rule.methods.length === 0 ? (
                  <Chip label={t("rulesPage.labels.all")} size="small" variant="outlined" />
                ) : (
                  rule.methods.map((m) => <Chip key={m} label={m} size="small" />)
                )}
                <IconButton size="small" color="error" onClick={() => handleDelete(rule)}>
                  <DeleteRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Stack>
            ))}
          </List>
        </Paper>
      )}
      <Dialog fullWidth maxWidth="sm" onClose={handleDialogClose} open={dialogOpen}>
        <DialogTitle>{t("rulesPage.addDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
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
            <FormControl size="small" fullWidth>
              <InputLabel>{urlPatternLabel}</InputLabel>
              <OutlinedInput
                label={urlPatternLabel}
                placeholder={t("rulesPage.urlPatternPlaceholder")}
                value={draft.urlPattern}
                onChange={(e) => setDraft({ ...draft, urlPattern: e.target.value })}
                sx={{ fontFamily: fontFamilies.mono, fontSize: 13 }}
              />
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{matchTypeLabel}</InputLabel>
              <Select
                label={matchTypeLabel}
                value={draft.matchType ?? "contains"}
                onChange={(e) => setDraft({ ...draft, matchType: e.target.value as MatchType })}
              >
                {matchTypes.map((mt) => (
                  <MenuItem key={mt.value} value={mt.value}>
                    {mt.label}
                  </MenuItem>
                ))}
              </Select>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  mt: 0.5,
                  lineHeight: 1.35,
                }}
              >
                {t(`rulesPage.editor.matchTypes.${draft.matchType ?? "contains"}Hint`)}
              </Typography>
            </FormControl>
            <Stack spacing={0.5}>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontWeight: 650,
                }}
              >
                {methodsLabel}
              </Typography>
              <Select
                displayEmpty
                multiple
                size="small"
                value={draft.methods}
                onChange={(e) => setDraft({ ...draft, methods: e.target.value as string[] })}
                renderValue={(s) => (s.length === 0 ? t("rulesPage.allMethods") : s.join(", "))}
              >
                {HTTP_METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </Stack>
            <FormControl size="small" fullWidth>
              <InputLabel>{stageLabel}</InputLabel>
              <Select
                value={draft.stage}
                label={stageLabel}
                onChange={(e) => setDraft({ ...draft, stage: e.target.value as BreakpointStage })}
              >
                <MenuItem value="request">{t("rulesPage.requestStageOption")}</MenuItem>
                <MenuItem value="response">{t("rulesPage.responseStageOption")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleDialogClose}>{t("common.actions.cancel")}</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={setRulesMutation.isPending || isRulesError}
          >
            {t("rulesPage.addRule")}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("rulesPage.deleteBreakpointTitle")}
        message={t("common.confirmDeleteMessage", {
          name: deleteTarget?.urlPattern || "*",
        })}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        isConfirming={setRulesMutation.isPending}
      />
    </Stack>
  );
}
