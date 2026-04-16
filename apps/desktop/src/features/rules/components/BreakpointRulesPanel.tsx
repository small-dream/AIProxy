import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import {
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
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import type { BreakpointRule, BreakpointStage } from "@aiproxy/shared-types";
import { useState } from "react";

import { useBreakpointRules, useSetBreakpointRules } from "@/features/breakpoints/use-breakpoint-rules";
import { createCatchAllRule, createEmptyBreakpointRule, HTTP_METHODS } from "@/features/rules/rules.helpers";
import { useI18n } from "@/i18n";
import { getSurfaceShadow } from "@/themes/app-theme";
import { fontFamilies } from "@/themes/fonts";

export function BreakpointRulesPanel() {
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
    setRulesMutation.mutate(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function handleDelete(id: string) {
    setRulesMutation.mutate(rules.filter((r) => r.id !== id));
  }

  function handleAddCatchAll(stage: BreakpointStage) {
    setRulesMutation.mutate([...rules, createCatchAllRule(stage)]);
  }

  const hasRequestCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "request" && r.methods.length === 0);
  const hasResponseCatchAll = rules.some((r) => r.enabled && r.urlPattern === "*" && r.stage === "response" && r.methods.length === 0);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button size="small" variant="outlined" disabled={hasRequestCatchAll} onClick={() => handleAddCatchAll("request")}>
          {t("rulesPage.breakOnAllRequests")}
        </Button>
        <Button size="small" variant="outlined" disabled={hasResponseCatchAll} onClick={() => handleAddCatchAll("response")}>
          {t("rulesPage.breakOnAllResponses")}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" startIcon={<AddRoundedIcon />} onClick={() => { setDraft(createEmptyBreakpointRule()); setDialogOpen(true); }}>
          {t("rulesPage.addRule")}
        </Button>
      </Stack>

      {rules.length === 0 ? (
        <Typography color="text.secondary" variant="body2" sx={{ py: 4, textAlign: "center" }}>
          {t("rulesPage.empty")}
        </Typography>
      ) : (
        <Paper
          elevation={0}
          sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", boxShadow: (theme) => getSurfaceShadow(theme.palette.mode) }}
        >
          <List disablePadding dense>
            {rules.map((rule) => (
              <Stack
                key={rule.id}
                direction="row"
                spacing={1.5}
                alignItems="center"
                sx={{ px: 2, py: 1, "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" } }}
              >
                <Switch size="small" checked={rule.enabled} onChange={() => handleToggle(rule.id)} />
                <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 13, flex: 1 }} noWrap>
                  {rule.urlPattern || "*"}
                </Typography>
                <Chip size="small" variant="outlined" color={rule.stage === "request" ? "info" : "secondary"} label={rule.stage === "request" ? t("rulesPage.stages.request") : t("rulesPage.stages.response")} />
                {rule.methods.length === 0 ? (
                  <Chip label={t("rulesPage.labels.all")} size="small" variant="outlined" />
                ) : (
                  rule.methods.map((m) => <Chip key={m} label={m} size="small" />)
                )}
                <IconButton size="small" color="error" onClick={() => handleDelete(rule.id)}>
                  <DeleteRoundedIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Stack>
            ))}
          </List>
        </Paper>
      )}

      <Dialog fullWidth maxWidth="sm" onClose={() => setDialogOpen(false)} open={dialogOpen}>
        <DialogTitle>{t("rulesPage.addDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <OutlinedInput
              placeholder={t("rulesPage.urlPatternPlaceholder")}
              value={draft.urlPattern}
              onChange={(e) => setDraft({ ...draft, urlPattern: e.target.value })}
              fullWidth
              sx={{ fontFamily: fontFamilies.mono, fontSize: 13 }}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.httpMethods")}</InputLabel>
              <Select
                multiple
                value={draft.methods}
                onChange={(e) => setDraft({ ...draft, methods: e.target.value as string[] })}
                input={<OutlinedInput label={t("rulesPage.labels.httpMethods")} />}
                renderValue={(s) => (s.length === 0 ? t("rulesPage.allMethods") : s.join(", "))}
              >
                {HTTP_METHODS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("rulesPage.labels.stage")}</InputLabel>
              <Select value={draft.stage} label={t("rulesPage.labels.stage")} onChange={(e) => setDraft({ ...draft, stage: e.target.value as BreakpointStage })}>
                <MenuItem value="request">{t("rulesPage.requestStageOption")}</MenuItem>
                <MenuItem value="response">{t("rulesPage.responseStageOption")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)}>{t("common.actions.cancel")}</Button>
          <Button variant="contained" onClick={handleSave} disabled={setRulesMutation.isPending}>{t("rulesPage.addRule")}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
