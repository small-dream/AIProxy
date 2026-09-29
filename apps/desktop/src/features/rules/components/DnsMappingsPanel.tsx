import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import MoreVertRoundedIcon from "@mui/icons-material/MoreVert";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { coerceAppError, type DnsMappingRule, DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { isMacPlatform } from "@/components/layout/hooks/helpers";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { deleteRule } from "@/services/commands";
import { useNotificationStore } from "@/services/notification.store";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import {
  createEmptyDnsMappingRule,
  getDnsMappingValidationErrors,
  hasRuleFieldErrors,
  isDnsMappingRuleEqual,
  type RulesPanelHandle,
  ruleFieldProps,
} from "@/features/rules/rules.helpers";
import {
  AdvancedPriorityField,
  EditorActionBar,
  FieldGroup,
  formatRuleFieldLabel,
  isEditableTarget,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleBatchBar,
  RuleEditorIdentity,
  RuleSection,
  UnsavedChangesIndicator,
} from "@/features/rules/components/RulesSharedUi";
import {
  computeReorderedPriorities,
  applyOrderedIdsWithinList,
  moveRuleInOrder,
  nextAppendedPriority,
  resolveNewRulePriority,
} from "@/features/rules/rules-priority.helpers";
import {
  DNS_MAPPINGS_QUERY_KEY,
  useBulkUpdateRules,
  useDeleteManagedRule,
  useDnsMappings,
  useSaveDnsMapping,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

export const DnsMappingsPanel = forwardRef<RulesPanelHandle>(
  function DnsMappingsPanel(_props, ref) {
    const { t } = useI18n();
    // Platform-aware glyph for the Save tooltip (⌘S on macOS, Ctrl+S elsewhere).
    const saveShortcutLabel = isMacPlatform() ? "⌘S" : "Ctrl+S";
    const queryClient = useQueryClient();
    const { data: rules = [], isError: isRulesError } = useDnsMappings(DEFAULT_WORKSPACE_ID);
    const saveMutation = useSaveDnsMapping();
    const deleteMutation = useDeleteManagedRule();
    const bulkMutation = useBulkUpdateRules();
    const [searchValue, setSearchValue] = useState("");
    const [selectedRuleId, setSelectedRuleId] = useState<string>();
    const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
    const [actionsMenuAnchor, setActionsMenuAnchor] = useState<HTMLElement | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [draft, setDraft] = useState<DnsMappingRule>(createEmptyDnsMappingRule());
    const [validationAttempted, setValidationAttempted] = useState(false);
    // Priority handed to the current draft while it is still unsaved, so the
    // save path can re-derive "append at the end" against the list as it looks
    // THEN (see resolveNewRulePriority).
    const autoPriorityRef = useRef<number | null>(null);

    const filteredRules = useMemo(() => {
      const q = searchValue.trim().toLowerCase();
      return [...rules]
        .sort((a, b) => b.priority - a.priority)
        .filter((r) => {
          if (!q) return true;
          return `${r.name} ${r.hostPattern} ${r.targetIp}`.toLowerCase().includes(q);
        });
    }, [rules, searchValue]);

    // P0-2 phase 2: the draft is "dirty" when it differs from its baseline — the
    // saved rule for an existing selection, or an empty rule for a new draft.
    // Mirrors the rewrite editor.
    const selectedSavedRule = useMemo(
      () => rules.find((rule) => rule.id === selectedRuleId),
      [rules, selectedRuleId],
    );
    const isDirty = useMemo(() => {
      const baseline = selectedSavedRule ?? createEmptyDnsMappingRule();
      return !isDnsMappingRuleEqual(draft, baseline);
    }, [draft, selectedSavedRule]);

    // Guards route navigation away AND in-component transitions that would
    // replace the in-flight draft; both share one confirmation dialog.
    const guard = useUnsavedChangesGuard(isDirty);

    useImperativeHandle(ref, () => ({ isDirty, confirmLeave: guard.confirmLeave }), [
      guard.confirmLeave,
      isDirty,
    ]);

    async function selectRule(rule: DnsMappingRule) {
      if (!(await guard.confirmLeave())) return;
      setSelectedRuleId(rule.id);
      setDraft(rule);
      setValidationAttempted(false);
    }

    async function handleCreateRule() {
      if (!(await guard.confirmLeave())) return;
      const d = createEmptyDnsMappingRule();
      // New rules append at the END of the list; that priority is resolved at
      // save time so the untouched draft still matches its empty-rule baseline.
      autoPriorityRef.current = d.priority;
      setSelectedRuleId(d.id);
      setDraft(d);
      setValidationAttempted(false);
    }

    async function handleDuplicateRule() {
      if (!(await guard.confirmLeave())) return;
      const priority = nextAppendedPriority(rules.map((rule) => rule.priority));
      const copy: DnsMappingRule = {
        ...draft,
        id: crypto.randomUUID(),
        name: `${draft.name.trim() || t("rulesPage.untitledRule")}${t("rulesPage.copySuffix")}`,
        priority,
      };
      autoPriorityRef.current = priority;
      setSelectedRuleId(copy.id);
      setDraft(copy);
      setValidationAttempted(false);
    }

    function handleSave() {
      if (isRulesError) return;
      setValidationAttempted(true);
      if (hasRuleFieldErrors(errors)) return;
      const priority = resolveNewRulePriority(draft, rules, autoPriorityRef.current);
      saveMutation.mutate(
        { ...draft, priority },
        {
          onSuccess: (saved) => {
            autoPriorityRef.current = null;
            setSelectedRuleId(saved.id);
            setDraft(saved);
            setValidationAttempted(false);
            useNotificationStore.getState().push(t("rulesPage.savedSuccess"), "success");
          },
        },
      );
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

    // Batch delete is as destructive as single delete, so it goes through the
    // same confirmation step (previously it deleted immediately).
    function handleBatchDelete() {
      if (selectedRuleIds.size === 0) return;
      setBatchDeleteConfirmOpen(true);
    }

    function confirmBatchDelete() {
      const ids = [...selectedRuleIds];
      if (ids.length === 0) {
        setBatchDeleteConfirmOpen(false);
        return;
      }
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
          setBatchDeleteConfirmOpen(false);
        },
      );
    }

    function handleReorder(orderedIds: string[]) {
      // The list is reorderable while a search filter hides rules, so map the
      // visible order back onto the full list before renumbering: hidden rules
      // keep their slots and the priorities stay a complete, collision-free set.
      const fullOrder = applyOrderedIdsWithinList(rules, orderedIds).map((rule) => rule.id);
      const currentPriorities = new Map(rules.map((rule) => [rule.id, rule.priority]));
      const updates = computeReorderedPriorities(fullOrder, currentPriorities);
      if (updates.length === 0) return;

      const previous = rules;
      const reordered = fullOrder
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

    // Page-scoped keyboard shortcuts (panel unmounts detach them): Cmd/Ctrl+S
    // saves (safe even inside text fields), Alt+ArrowUp/ArrowDown reorders the
    // selected rule. Everything except Cmd/Ctrl+S is ignored while focus is in
    // an editable control.
    const shortcutStateRef = useRef({ isDirty, selectedRuleId, filteredRules });
    useEffect(() => {
      shortcutStateRef.current = { isDirty, selectedRuleId, filteredRules };
    }, [isDirty, selectedRuleId, filteredRules]);
    const handleSaveRef = useRef(handleSave);
    useEffect(() => {
      handleSaveRef.current = handleSave;
    });
    const reorderRef = useRef(handleReorder);
    useEffect(() => {
      reorderRef.current = handleReorder;
    });
    useEffect(() => {
      function handleKeyDown(event: KeyboardEvent) {
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (shortcutStateRef.current.isDirty) handleSaveRef.current();
          return;
        }
        // List-row Alt+Arrow reorder marks the event handled; don't double-move.
        if (event.defaultPrevented) return;
        if (isEditableTarget(event.target)) return;
        if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          const { selectedRuleId: selected, filteredRules: list } = shortcutStateRef.current;
          if (!selected) return;
          const next = moveRuleInOrder(
            list.map((rule) => rule.id),
            selected,
            event.key === "ArrowUp" ? -1 : 1,
          );
          if (!next) return;
          event.preventDefault();
          reorderRef.current(next);
        }
      }
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

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
          listControlsHidden={rules.length === 0}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          createActions={
            <Button
              size="small"
              variant="contained"
              disabled={isRulesError}
              startIcon={<AddRoundedIcon />}
              onClick={handleCreateRule}
            >
              {t("rulesPage.dns.createRule")}
            </Button>
          }
          list={
            <ManagedRuleList
              emptyActions={
                <Button
                  size="small"
                  variant="contained"
                  disabled={isRulesError}
                  startIcon={<AddRoundedIcon />}
                  onClick={handleCreateRule}
                >
                  {t("rulesPage.dns.createRule")}
                </Button>
              }
              emptyDescription={t("rulesPage.dns.emptyDescription")}
              onReorder={handleReorder}
              selectedIds={selectedRuleIds}
              items={filteredRules.map((rule) => ({
                id: rule.id,
                active: rule.id === selectedRuleId,
                enabled: rule.enabled,
                name: rule.name || t("rulesPage.untitledRule"),
                subtitle: `${rule.hostPattern || "*"} → ${rule.targetIp || t("rulesPage.notConfigured")}`,
                onClick: () => selectRule(rule),
                onSelectToggle: () => toggleSelect(rule.id),
                // Persist the SAVED rule (not the in-flight draft) so the toggle
                // takes effect immediately (review §4.1).
                onToggleEnabled: (enabled) => saveMutation.mutate({ ...rule, enabled }),
              }))}
            />
          }
          listFooter={
            rules.length > 0 ? (
              <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.4 }}>
                {t("rulesPage.listReorderHint")}
              </Typography>
            ) : undefined
          }
          editorFooter={
            <EditorActionBar>
              {isDirty && (
                <UnsavedChangesIndicator label={t("rulesPage.unsavedChangesIndicator")} />
              )}
              <Box sx={{ flex: 1 }} />
              <Tooltip title={saveShortcutLabel}>
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveRoundedIcon />}
                    onClick={handleSave}
                    disabled={saveMutation.isPending || isRulesError}
                  >
                    {t("rulesPage.editor.saveRule")}
                  </Button>
                </span>
              </Tooltip>
              <IconButton
                size="small"
                aria-label={t("rulesPage.ruleActions")}
                aria-haspopup="menu"
                disabled={isRulesError}
                onClick={(event) => setActionsMenuAnchor(event.currentTarget)}
              >
                <MoreVertRoundedIcon fontSize="small" />
              </IconButton>
            </EditorActionBar>
          }
          editor={
            <Stack spacing={2}>
              <RuleEditorIdentity
                advanced={
                  <AdvancedPriorityField
                    value={draft.priority}
                    onCommit={(priority) => setDraft({ ...draft, priority })}
                  />
                }
                advancedOpen={advancedOpen}
                enabled={draft.enabled}
                name={draft.name}
                nameFieldProps={ruleFieldProps(errors, validationAttempted, "name")}
                onNameChange={(name) => setDraft({ ...draft, name })}
                onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
                onToggleEnabled={(enabled) => setDraft({ ...draft, enabled })}
              />

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
          cancelLabel={t("common.actions.keepEditing")}
          confirmColor="warning"
          confirmLabel={t("common.actions.discard")}
          message={t("rulesPage.unsavedChangesMessage")}
          onCancel={guard.handleCancel}
          onConfirm={guard.handleConfirm}
          open={guard.dialogOpen}
          title={t("rulesPage.unsavedChangesTitle")}
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

        <ConfirmDialog
          open={batchDeleteConfirmOpen}
          title={t("rulesPage.batch.deleteConfirmTitle")}
          message={t("rulesPage.batch.deleteConfirmMessage", { count: selectedRuleIds.size })}
          onConfirm={confirmBatchDelete}
          onCancel={() => setBatchDeleteConfirmOpen(false)}
        />

        <Menu
          anchorEl={actionsMenuAnchor}
          open={actionsMenuAnchor !== null}
          onClose={() => setActionsMenuAnchor(null)}
        >
          <MenuItem
            onClick={() => {
              setActionsMenuAnchor(null);
              void handleDuplicateRule();
            }}
          >
            <ContentCopyRoundedIcon fontSize="small" sx={{ mr: 1 }} />
            {t("rulesPage.duplicateRule")}
          </MenuItem>
          <MenuItem
            disabled={deleteMutation.isPending}
            onClick={() => {
              setActionsMenuAnchor(null);
              handleDelete();
            }}
            sx={{ color: "error.main" }}
          >
            <DeleteRoundedIcon fontSize="small" sx={{ mr: 1 }} />
            {t("common.actions.remove")}
          </MenuItem>
        </Menu>
      </>
    );
  },
);
