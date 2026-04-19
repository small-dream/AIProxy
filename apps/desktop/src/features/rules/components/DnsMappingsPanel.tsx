import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { DnsMappingRule } from "@aiproxy/shared-types";
import { DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
import { useMemo, useState } from "react";

import { createEmptyDnsMappingRule, getDnsMappingValidationErrors } from "@/features/rules/rules.helpers";
import { FieldGroup, ManagedRuleList, ManagedRulesWorkbench } from "@/features/rules/components/RulesSharedUi";
import { useDeleteManagedRule, useDnsMappings, useSaveDnsMapping } from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

export function DnsMappingsPanel() {
  const { t } = useI18n();
  const { data: rules = [] } = useDnsMappings(DEFAULT_WORKSPACE_ID);
  const saveMutation = useSaveDnsMapping();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<DnsMappingRule>(createEmptyDnsMappingRule());

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules].sort((a, b) => b.priority - a.priority).filter((r) => {
      if (!q) return true;
      return `${r.name} ${r.hostPattern} ${r.targetIp}`.toLowerCase().includes(q);
    });
  }, [rules, searchValue]);

  function selectRule(rule: DnsMappingRule) { setSelectedRuleId(rule.id); setDraft(rule); }

  function handleCreateRule() {
    const d = createEmptyDnsMappingRule();
    setSelectedRuleId(d.id);
    setDraft(d);
  }

  function handleSave() {
    saveMutation.mutate(draft, { onSuccess: (saved) => { setSelectedRuleId(saved.id); setDraft(saved); } });
  }

  function handleDelete() {
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
      setDraft(createEmptyDnsMappingRule());
      setSelectedRuleId(undefined);
      return;
    }
    deleteMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "dns" },
      { onSuccess: () => { setSelectedRuleId(undefined); setDraft(createEmptyDnsMappingRule()); } },
    );
  }

  const errors = getDnsMappingValidationErrors(draft, t);

  return (
    <ManagedRulesWorkbench
      searchPlaceholder={t("rulesPage.dns.searchPlaceholder")}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      createActions={
        <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={handleCreateRule}>
          {t("rulesPage.dns.createRule")}
        </Button>
      }
      list={(
        <ManagedRuleList
          emptyDescription={t("rulesPage.dns.emptyDescription")}
          items={filteredRules.map((rule) => ({
            id: rule.id,
            active: rule.id === selectedRuleId,
            enabled: rule.enabled,
            name: rule.name || t("rulesPage.untitledRule"),
            subtitle: `${rule.hostPattern || "*"} → ${rule.targetIp || t("rulesPage.notConfigured")}`,
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

          {/* DNS mapping config */}
          <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
            <FieldGroup title={t("rulesPage.dns.title")}>
              <TextField
                size="small"
                label={t("rulesPage.dns.hostPattern")}
                value={draft.hostPattern}
                onChange={(e) => setDraft({ ...draft, hostPattern: e.target.value })}
                placeholder={t("rulesPage.dns.hostPatternExample")}
                fullWidth
              />
              <TextField
                size="small"
                label={t("rulesPage.dns.targetIp")}
                value={draft.targetIp}
                onChange={(e) => setDraft({ ...draft, targetIp: e.target.value })}
                placeholder={t("rulesPage.dns.targetIpExample")}
                fullWidth
              />
            </FieldGroup>
          </Paper>
        </Stack>
      )}
    />
  );
}
