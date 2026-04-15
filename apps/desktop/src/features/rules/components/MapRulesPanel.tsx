import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import type { MapRule } from "@pharles/shared-types";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createEmptyMapRule, getMapValidationErrors } from "@/features/rules/rules.helpers";
import { FieldGroup, InlineSwitch, ManagedRuleList, ManagedRulesWorkbench } from "@/features/rules/components/RulesSharedUi";
import { useDeleteManagedRule, useMapRules, useSaveMapRule } from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

export function MapRulesPanel({ mode }: { mode: MapRule["mode"] }) {
  const { t } = useI18n();
  const { data: rules = [] } = useMapRules(mode);
  const saveMutation = useSaveMapRule();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<MapRule>(createEmptyMapRule(mode));

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules].sort((a, b) => b.priority - a.priority).filter((r) => {
      if (!q) return true;
      return `${r.name} ${r.sourcePattern} ${r.targetValue}`.toLowerCase().includes(q);
    });
  }, [rules, searchValue]);

  useEffect(() => {
    if (draft.mode !== mode) { setDraft(createEmptyMapRule(mode)); setSelectedRuleId(undefined); }
  }, [draft.mode, mode]);

  useEffect(() => {
    if (selectedRuleId && rules.some((r) => r.id === selectedRuleId)) return;
    const next = filteredRules[0];
    if (next) { setSelectedRuleId(next.id); setDraft(next); return; }
    setSelectedRuleId(undefined);
  }, [filteredRules, rules, selectedRuleId]);

  function selectRule(rule: MapRule) { setSelectedRuleId(rule.id); setDraft(rule); }

  function handleCreateRule() {
    const d = createEmptyMapRule(mode);
    setSelectedRuleId(d.id);
    setDraft(d);
  }

  function handleSave() {
    saveMutation.mutate(draft, { onSuccess: (saved) => { setSelectedRuleId(saved.id); setDraft(saved); } });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) { setDraft(createEmptyMapRule(mode)); setSelectedRuleId(undefined); return; }
    deleteMutation.mutate({ ruleId: selectedRuleId, ruleType: "map" }, { onSuccess: () => { setSelectedRuleId(undefined); setDraft(createEmptyMapRule(mode)); } });
  }

  const errors = getMapValidationErrors(draft, t);
  const isLocal = mode === "local";

  const handlePickFile = useCallback(async () => {
    const selected = await open({ directory: false, multiple: false, title: t("rulesPage.mapLocal.pickFile") });
    if (selected) {
      setDraft((d) => ({ ...d, targetValue: selected }));
    }
  }, [t]);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: t("rulesPage.mapLocal.pickFolder") });
    if (selected) {
      setDraft((d) => ({ ...d, targetValue: selected }));
    }
  }, [t]);

  return (
    <ManagedRulesWorkbench
      searchPlaceholder={isLocal ? t("rulesPage.mapLocal.searchPlaceholder") : t("rulesPage.mapRemote.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={
        <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={handleCreateRule}>
          {isLocal ? t("rulesPage.mapLocal.createRule") : t("rulesPage.mapRemote.createRule")}
        </Button>
      }
      list={(
        <ManagedRuleList
          emptyDescription={isLocal ? t("rulesPage.mapLocal.emptyDescription") : t("rulesPage.mapRemote.emptyDescription")}
          items={filteredRules.map((rule) => ({
            id: rule.id,
            active: rule.id === selectedRuleId,
            enabled: rule.enabled,
            name: rule.name || t("rulesPage.untitledRule"),
            subtitle: `${rule.sourcePattern || "*"} → ${rule.targetValue || t("rulesPage.notConfigured")}`,
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

          {/* Mapping config */}
          <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
            <FieldGroup title={t("rulesPage.mapEditor.matchTitle")}>
              <TextField
                size="small"
                label={t("rulesPage.mapEditor.sourcePattern")}
                value={draft.sourcePattern}
                onChange={(e) => setDraft({ ...draft, sourcePattern: e.target.value })}
                placeholder="https://example.com/assets/*"
                fullWidth
              />
              <TextField
                size="small"
                label={isLocal ? t("rulesPage.mapLocal.targetPath") : t("rulesPage.mapRemote.targetUrl")}
                value={draft.targetValue}
                onChange={(e) => setDraft({ ...draft, targetValue: e.target.value })}
                placeholder={isLocal ? "/Users/you/project/dist" : "https://staging.example.com"}
                fullWidth
                InputProps={isLocal ? {
                  endAdornment: (
                    <InputAdornment position="end" sx={{ mr: -0.5 }}>
                      <Stack spacing={-0.5}>
                        <Tooltip title={t("rulesPage.mapLocal.pickFile")}>
                          <IconButton size="small" onClick={handlePickFile}>
                            <FolderOpenRoundedIcon sx={{ fontSize: 18 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t("rulesPage.mapLocal.pickFolder")}>
                          <IconButton size="small" onClick={handlePickFolder}>
                            <FolderOpenRoundedIcon sx={{ fontSize: 18, opacity: 0.6 }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </InputAdornment>
                  ),
                } : undefined}
              />
              <Stack direction="row" spacing={2}>
                <InlineSwitch label={t("rulesPage.mapEditor.preservePath")} checked={draft.preservePath} onChange={(v) => setDraft({ ...draft, preservePath: v })} />
                <InlineSwitch label={t("rulesPage.mapEditor.preserveQuery")} checked={draft.preserveQuery} onChange={(v) => setDraft({ ...draft, preserveQuery: v })} />
              </Stack>
            </FieldGroup>
          </Paper>
        </Stack>
      )}
    />
  );
}
