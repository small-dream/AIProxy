import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import { Alert, Button, Stack, Switch, TextField, Typography } from "@mui/material";
import { coerceAppError, type DnsMappingRule, DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { deleteRule } from "@/services/commands";
import { useNotificationStore } from "@/services/notification.store";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import { PriorityField } from "@/features/rules/components/PriorityField";
import {
  createEmptyDnsMappingRule,
  getDnsMappingValidationErrors,
  hasRuleFieldErrors,
  ruleFieldProps,
} from "@/features/rules/rules.helpers";
import {
  FieldGroup,
  formatRuleFieldLabel,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleBatchBar,
  RuleSection,
} from "@/features/rules/components/RulesSharedUi";
import { computeReorderedPriorities } from "@/features/rules/rules-priority.helpers";
import {
  DNS_MAPPINGS_QUERY_KEY,
  useBulkUpdateRules,
  useDeleteManagedRule,
  useDnsMappings,
  useSaveDnsMapping,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

export function DnsMappingsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: rules = [], isError: isRulesError } = useDnsMappings(DEFAULT_WORKSPACE_ID);
  const saveMutation = useSaveDnsMapping();
  const deleteMutation = useDeleteManagedRule();
  const bulkMutation = useBulkUpdateRules();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<DnsMappingRule>(createEmptyDnsMappingRule());
  const [validationAttempted, setValidationAttempted] = useState(false);

  const filteredRules = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .filter((r) => {
        if (!q) return true;
        return `${r.name} ${r.hostPattern} ${r.targetIp}`.toLowerCase().includes(q);
      });
  }, [rules, searchValue]);

  function selectRule(rule: DnsMappingRule) {
    setSelectedRuleId(rule.id);
    setDraft(rule);
    setValidationAttempted(false);
  }

  function handleCreateRule() {
    const d = createEmptyDnsMappingRule();
    setSelectedRuleId(d.id);
    setDraft(d);
    setValidationAttempted(false);
  }

  function handleSave() {
    if (isRulesError) return;
    setValidationAttempted(true);
    if (hasRuleFieldErrors(errors)) return;
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
    if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
      setDraft(createEmptyDnsMappingRule());
      setSelectedRuleId(undefined);
      setValidationAttempted(false);
      return;
    }
    // Destructive: confirm before the persisted rule is removed.
    setDeleteConfirmOpen(true);
  }

  function confirmDelete() {
    if (!selectedRuleId) return;
    deleteMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "dns" },
      {
        onSuccess: () => {
          setSelectedRuleId(undefined);
          setDraft(createEmptyDnsMappingRule());
          setValidationAttempted(false);
          setDeleteConfirmOpen(false);
        },
      },
    );
  }

  const errors = getDnsMappingValidationErrors(draft, t);
  const saveError = saveMutation.error ? coerceAppError(saveMutation.error).message : undefined;

  function toggleSelect(id: string) {
    setSelectedRuleIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedRuleIds(new Set());
  }

  function handleBatchEnabled(enabled: boolean) {
    const updates = [...selectedRuleIds].map((id) => ({ id, enabled }));
    if (updates.length === 0) return;
    bulkMutation.mutate(
      { ruleType: "dns", updates },
      {
        onSettled: () => clearSelection(),
      },
    );
  }

  function handleBatchDelete() {
    const ids = [...selectedRuleIds];
    if (ids.length === 0) return;
    void Promise.allSettled(ids.map((ruleId) => deleteRule({ ruleId, ruleType: "dns" }))).then(
      (results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        useNotificationStore.getState().push(
          failed > 0
            ? t("rulesPage.batch.resultPartial", {
                applied: ids.length - failed,
                total: ids.length,
              })
            : t("rulesPage.batch.resultSuccess", { count: ids.length }),
        );
        clearSelection();
      },
    );
  }

  function handleReorder(orderedIds: string[]) {
    const currentPriorities = new Map(rules.map((rule) => [rule.id, rule.priority]));
    const updates = computeReorderedPriorities(orderedIds, currentPriorities);
    if (updates.length === 0) return;

    const previous = rules;
    const reordered = orderedIds
      .map((id) => rules.find((rule) => rule.id === id))
      .filter((rule): rule is DnsMappingRule => rule !== undefined);
    queryClient.setQueryData([...DNS_MAPPINGS_QUERY_KEY, DEFAULT_WORKSPACE_ID], reordered);
    bulkMutation.mutate(
      { ruleType: "dns", updates },
      {
        onError: () => {
          queryClient.setQueryData([...DNS_MAPPINGS_QUERY_KEY, DEFAULT_WORKSPACE_ID], previous);
          queryClient.invalidateQueries({ queryKey: DNS_MAPPINGS_QUERY_KEY });
        },
      },
    );
  }

  return (
    <>
      {isRulesError && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {t("common.errors.generic")}
        </Alert>
      )}
      <ManagedRulesWorkbench
        batchBar={
          selectedRuleIds.size > 0 ? (
            <RuleBatchBar
              count={selectedRuleIds.size}
              deletePending={false}
              onDelete={handleBatchDelete}
              onDisable={() => handleBatchEnabled(false)}
              onDone={clearSelection}
              onEnable={() => handleBatchEnabled(true)}
            />
          ) : undefined
        }
        searchPlaceholder={t("rulesPage.dns.searchPlaceholder")}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        createActions={
          <Button
            size="small"
            variant="outlined"
            disabled={isRulesError}
            startIcon={<AddRoundedIcon />}
            onClick={handleCreateRule}
          >
            {t("rulesPage.dns.createRule")}
          </Button>
        }
        list={
          <ManagedRuleList
            emptyDescription={t("rulesPage.dns.emptyDescription")}
            onReorder={handleReorder}
            selectedIds={selectedRuleIds}
            items={filteredRules.map((rule) => ({
              id: rule.id,
              active: rule.id === selectedRuleId,
              enabled: rule.enabled,
              name: rule.name || t("rulesPage.untitledRule"),
              subtitle: `${rule.hostPattern || "*"} → ${rule.targetIp || t("rulesPage.notConfigured")}`,
              chipLabel: `${rule.priority}`,
              onClick: () => selectRule(rule),
              onSelectToggle: () => toggleSelect(rule.id),
              // Persist the SAVED rule (not the in-flight draft) so the toggle
              // takes effect immediately (review §4.1).
              onToggleEnabled: (enabled) => saveMutation.mutate({ ...rule, enabled }),
            }))}
          />
        }
        editor={
          <Stack spacing={2}>
            {/* Top bar */}
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={1.25}
              sx={{
                alignItems: { xs: "stretch", md: "center" },
                borderBottom: 1,
                borderColor: "divider",
                pb: 1.5,
              }}
            >
              <TextField
                size="small"
                label={formatRuleFieldLabel(t("rulesPage.editor.ruleName"), "required", t)}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                {...ruleFieldProps(errors, validationAttempted, "name")}
                sx={{ flex: 1 }}
              />
              <Stack
                direction="row"
                spacing={0.75}
                sx={{
                  alignItems: "center",
                  border: 1,
                  borderColor: "divider",
                  borderRadius: "8px",
                  minHeight: 40,
                  px: 1,
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {t("rulesPage.editor.enabled")}
                </Typography>
                <Switch
                  size="small"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
              </Stack>
              <PriorityField
                value={draft.priority}
                label={formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t)}
                onCommit={(priority) => setDraft({ ...draft, priority })}
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

            {saveError && (
              <Alert severity="error" variant="outlined">
                {saveError}
              </Alert>
            )}

            {/* DNS mapping config */}
            <RuleSection>
              <FieldGroup title={t("rulesPage.dns.title")}>
                <TextField
                  size="small"
                  label={formatRuleFieldLabel(t("rulesPage.dns.hostPattern"), "required", t)}
                  value={draft.hostPattern}
                  onChange={(e) => setDraft({ ...draft, hostPattern: e.target.value })}
                  {...ruleFieldProps(errors, validationAttempted, "hostPattern")}
                  placeholder={t("rulesPage.dns.hostPatternExample")}
                  fullWidth
                />
                <MatchTypeSelect
                  value={draft.matchType}
                  onChange={(matchType) => setDraft({ ...draft, matchType })}
                />
                <TextField
                  size="small"
                  label={formatRuleFieldLabel(t("rulesPage.dns.targetIp"), "required", t)}
                  value={draft.targetIp}
                  onChange={(e) => setDraft({ ...draft, targetIp: e.target.value })}
                  {...ruleFieldProps(errors, validationAttempted, "targetIp")}
                  placeholder={t("rulesPage.dns.targetIpExample")}
                  fullWidth
                />
              </FieldGroup>
            </RuleSection>
          </Stack>
        }
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t("rulesPage.deleteRuleTitle")}
        message={t("common.confirmDeleteMessage", {
          name: draft.name.trim() || draft.hostPattern,
        })}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
        isConfirming={deleteMutation.isPending}
      />
    </>
  );
}
