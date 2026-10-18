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
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { coerceAppError, type BreakpointRule, type BreakpointStage } from "@aiproxy/shared-types";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { isMacPlatform } from "@/components/layout/hooks/helpers";
import {
  useBreakpointRules,
  useSetBreakpointRules,
} from "@/features/breakpoints/use-breakpoint-rules";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useNotificationStore } from "@/services/notification.store";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import {
  createCatchAllRule,
  createEmptyBreakpointRule,
  getBreakpointValidationErrors,
  hasRuleFieldErrors,
  HTTP_METHODS,
  isBreakpointRuleEqual,
  type RulesPanelHandle,
  ruleFieldProps,
} from "@/features/rules/rules.helpers";
import {
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
  reorderShortcutLabel,
  useClearMutationErrorOnRuleChange,
} from "@/features/rules/components/RulesSharedUi";
import {
  applyOrderedIdsWithinList,
  moveRuleInOrder,
} from "@/features/rules/rules-priority.helpers";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export const BreakpointRulesPanel = forwardRef<RulesPanelHandle>(
  function BreakpointRulesPanel(_props, ref) {
    const { t } = useI18n();
    // Platform-aware glyph for the Save tooltip (⌘S on macOS, Ctrl+S elsewhere).
    const saveShortcutLabel = isMacPlatform() ? "⌘S" : "Ctrl+S";
    const { data: rules = [], isError: isRulesError } = useBreakpointRules();
    const setRulesMutation = useSetBreakpointRules();
    const [searchValue, setSearchValue] = useState("");
    const [selectedRuleId, setSelectedRuleId] = useState<string>();
    const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
    const [actionsMenuAnchor, setActionsMenuAnchor] = useState<HTMLElement | null>(null);
    const [draft, setDraft] = useState<BreakpointRule>(createEmptyBreakpointRule());
    const [validationAttempted, setValidationAttempted] = useState(false);
    // M22: track the last id we synced a draft FROM, so a TanStack Query refetch
    // (new rules[]/filteredRules[] array identity) does NOT re-run the draft-
    // sync and clobber an in-flight edit. Mirrors the other rule panels.
    const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);

    // Breakpoint rules have no numeric priority: the persisted array order IS
    // the evaluation order (first matching rule triggers the intercept), so the
    // list keeps the stored order instead of sorting.
    const filteredRules = useMemo(() => {
      const q = searchValue.trim().toLowerCase();
      if (!q) return rules;
      return rules.filter((rule) =>
        `${rule.urlPattern} ${rule.stage} ${rule.methods.join(" ")}`.toLowerCase().includes(q),
      );
    }, [rules, searchValue]);

    useEffect(() => {
      // M22: only sync the draft when the selection actually changes — NOT on
      // every rules[] refetch. Protects in-flight edits from being clobbered.
      const selectionValid =
        selectedRuleId &&
        (rules.some((r) => r.id === selectedRuleId) || draft.id === selectedRuleId);
      if (selectionValid) {
        lastSyncedRuleIdRef.current = selectedRuleId;
        return;
      }
      const next = filteredRules[0];
      if (next) {
        if (lastSyncedRuleIdRef.current === next.id) return;
        lastSyncedRuleIdRef.current = next.id;
        setSelectedRuleId(next.id);
        setDraft(next);
        setValidationAttempted(false);
        return;
      }
      if (lastSyncedRuleIdRef.current === undefined) return;
      lastSyncedRuleIdRef.current = undefined;
      setSelectedRuleId(undefined);
      setValidationAttempted(false);
    }, [draft.id, filteredRules, rules, selectedRuleId]);

    // P0-2 phase 2: the draft is "dirty" when it differs from its baseline — the
    // saved rule for an existing selection, or an empty rule for a new draft.
    const selectedSavedRule = useMemo(
      () => rules.find((rule) => rule.id === selectedRuleId),
      [rules, selectedRuleId],
    );
    const isDirty = useMemo(() => {
      const baseline = selectedSavedRule ?? createEmptyBreakpointRule();
      return !isBreakpointRuleEqual(draft, baseline);
    }, [draft, selectedSavedRule]);

    // Guards route navigation away AND in-component transitions that would
    // replace the in-flight draft; both share one confirmation dialog.
    const guard = useUnsavedChangesGuard(isDirty);

    useImperativeHandle(ref, () => ({ isDirty, confirmLeave: guard.confirmLeave }), [
      guard.confirmLeave,
      isDirty,
    ]);

    useClearMutationErrorOnRuleChange(setRulesMutation, selectedRuleId);

    async function selectRule(rule: BreakpointRule) {
      if (!(await guard.confirmLeave())) return;
      lastSyncedRuleIdRef.current = rule.id;
      setSelectedRuleId(rule.id);
      setDraft(rule);
      setValidationAttempted(false);
    }

    async function handleCreateRule() {
      if (!(await guard.confirmLeave())) return;
      const d = createEmptyBreakpointRule();
      lastSyncedRuleIdRef.current = d.id;
      setSelectedRuleId(d.id);
      setDraft(d);
      setValidationAttempted(false);
    }

    async function handleDuplicateRule() {
      if (!(await guard.confirmLeave())) return;
      // Breakpoint rules have no name to suffix; the copy differs only by id.
      const copy: BreakpointRule = { ...draft, id: crypto.randomUUID() };
      lastSyncedRuleIdRef.current = copy.id;
      setSelectedRuleId(copy.id);
      setDraft(copy);
      setValidationAttempted(false);
    }

    function handleSave() {
      if (isRulesError) return;
      setValidationAttempted(true);
      if (hasRuleFieldErrors(errors)) return;
      // Breakpoint rules persist as one whole list, so a save is an upsert.
      const next = rules.some((rule) => rule.id === draft.id)
        ? rules.map((rule) => (rule.id === draft.id ? draft : rule))
        : [...rules, draft];
      setRulesMutation.mutate(next, {
        onSuccess: () => {
          lastSyncedRuleIdRef.current = draft.id;
          setSelectedRuleId(draft.id);
          setValidationAttempted(false);
          useNotificationStore.getState().push(t("rulesPage.savedSuccess"), "success");
        },
      });
    }

    function handleDelete() {
      if (isRulesError) return;
      if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
        // Unsaved new draft: nothing persisted, so discard without confirmation.
        lastSyncedRuleIdRef.current = undefined;
        setDraft(createEmptyBreakpointRule());
        setSelectedRuleId(undefined);
        setValidationAttempted(false);
        return;
      }
      // Destructive: confirm before the persisted rule is removed.
      setDeleteConfirmOpen(true);
    }

    function confirmDelete() {
      if (!selectedRuleId) return;
      const id = selectedRuleId;
      setRulesMutation.mutate(
        rules.filter((rule) => rule.id !== id),
        {
          onSuccess: () => {
            lastSyncedRuleIdRef.current = undefined;
            setSelectedRuleId(undefined);
            setDraft(createEmptyBreakpointRule());
            setValidationAttempted(false);
            setDeleteConfirmOpen(false);
          },
        },
      );
    }

    function handleAddCatchAll(stage: BreakpointStage) {
      setRulesMutation.mutate([...rules, createCatchAllRule(stage)]);
    }

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
      if (selectedRuleIds.size === 0) return;
      setRulesMutation.mutate(
        rules.map((rule) => (selectedRuleIds.has(rule.id) ? { ...rule, enabled } : rule)),
        { onSettled: () => clearSelection() },
      );
    }

    // Batch delete is as destructive as single delete, so it goes through the
    // same confirmation step.
    function handleBatchDelete() {
      if (selectedRuleIds.size === 0) return;
      setBatchDeleteConfirmOpen(true);
    }

    function confirmBatchDelete() {
      const ids = selectedRuleIds;
      if (ids.size === 0) {
        setBatchDeleteConfirmOpen(false);
        return;
      }
      setRulesMutation.mutate(
        rules.filter((rule) => !ids.has(rule.id)),
        {
          onSuccess: () => {
            useNotificationStore
              .getState()
              .push(t("rulesPage.batch.resultSuccess", { count: ids.size }));
            clearSelection();
            setBatchDeleteConfirmOpen(false);
            // The batch may have removed the rule the editor is showing.
            if (selectedRuleId && ids.has(selectedRuleId)) {
              lastSyncedRuleIdRef.current = undefined;
              setSelectedRuleId(undefined);
              setDraft(createEmptyBreakpointRule());
              setValidationAttempted(false);
            }
          },
        },
      );
    }

    function handleReorder(orderedIds: string[]) {
      // The persisted array order IS the evaluation order (first match wins), so
      // a reorder replaces the whole list. Items hidden by an active search
      // filter keep their slots; visible items take their new relative order.
      setRulesMutation.mutate(applyOrderedIdsWithinList(rules, orderedIds));
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

    const errors = getBreakpointValidationErrors(draft, t);
    const saveError = setRulesMutation.error
      ? coerceAppError(setRulesMutation.error).message
      : undefined;
    const hasRequestCatchAll = rules.some(
      (r) => r.enabled && r.urlPattern === "*" && r.stage === "request" && r.methods.length === 0,
    );
    const hasResponseCatchAll = rules.some(
      (r) => r.enabled && r.urlPattern === "*" && r.stage === "response" && r.methods.length === 0,
    );
    const urlPatternLabel = formatRuleFieldLabel(t("rulesPage.editor.urlPattern"), "required", t);
    const methodsLabel = formatRuleFieldLabel(t("rulesPage.labels.httpMethods"), "optional", t);
    const stageLabel = formatRuleFieldLabel(t("rulesPage.labels.stage"), "required", t);
    // Scope hint: a bare `*` intercepts everything at the chosen stage; a regex
    // can match far more traffic than intended.
    const scopeHint =
      draft.urlPattern.trim() === "*"
        ? t("rulesPage.breakpoint.scopeHintAllTraffic")
        : (draft.matchType ?? "contains") === "regex" && draft.urlPattern.trim()
          ? t("rulesPage.breakpoint.scopeHintRegex")
          : undefined;

    const createActions = (
      <>
        <Button
          size="small"
          variant="contained"
          disabled={isRulesError}
          startIcon={<AddRoundedIcon />}
          onClick={() => void handleCreateRule()}
        >
          {t("rulesPage.breakpoint.createRule")}
        </Button>
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
      </>
    );

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
          searchPlaceholder={t("rulesPage.breakpoint.searchPlaceholder")}
          listControlsHidden={rules.length === 0}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          createActions={createActions}
          list={
            <ManagedRuleList
              emptyActions={createActions}
              emptyDescription={t("rulesPage.breakpoint.emptyDescription")}
              onReorder={handleReorder}
              selectedIds={selectedRuleIds}
              items={filteredRules.map((rule) => ({
                id: rule.id,
                active: rule.id === selectedRuleId,
                enabled: rule.enabled,
                name: rule.urlPattern || "*",
                subtitle: `${
                  rule.stage === "request"
                    ? t("rulesPage.stages.request")
                    : t("rulesPage.stages.response")
                } • ${
                  rule.methods.length === 0 ? t("rulesPage.labels.all") : rule.methods.join(", ")
                }`,
                onClick: () => void selectRule(rule),
                onSelectToggle: () => toggleSelect(rule.id),
                // Persist the SAVED rule (not the in-flight draft) so the toggle
                // takes effect immediately (review §4.1).
                onToggleEnabled: (enabled) =>
                  setRulesMutation.mutate(
                    rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
                  ),
              }))}
            />
          }
          listFooter={
            rules.length > 0 ? (
              <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.4 }}>
                {t("rulesPage.listReorderHint", { alt: reorderShortcutLabel() })}
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
                    disabled={setRulesMutation.isPending || isRulesError}
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
                enabled={draft.enabled}
                hint={scopeHint}
                onToggleEnabled={(enabled) => setDraft({ ...draft, enabled })}
              />

              {saveError && (
                <Alert severity="error" variant="outlined">
                  {saveError}
                </Alert>
              )}

              {/* Match config */}
              <RuleSection>
                <FieldGroup title={t("rulesPage.editor.matchTitle")}>
                  <TextField
                    size="small"
                    label={urlPatternLabel}
                    value={draft.urlPattern}
                    onChange={(e) => setDraft({ ...draft, urlPattern: e.target.value })}
                    {...ruleFieldProps(errors, validationAttempted, "urlPattern")}
                    placeholder={t("rulesPage.urlPatternPlaceholder")}
                    sx={{ "& input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
                    fullWidth
                  />
                  <MatchTypeSelect
                    value={draft.matchType}
                    onChange={(matchType) => setDraft({ ...draft, matchType })}
                  />
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
                      renderValue={(s) =>
                        s.length === 0 ? t("rulesPage.allMethods") : s.join(", ")
                      }
                    >
                      {HTTP_METHODS.map((m) => (
                        <MenuItem key={m} value={m}>
                          {m}
                        </MenuItem>
                      ))}
                    </Select>
                  </Stack>
                  <Stack spacing={0.5}>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        fontWeight: 650,
                      }}
                    >
                      {stageLabel}
                    </Typography>
                    <Select
                      size="small"
                      value={draft.stage}
                      onChange={(e) =>
                        setDraft({ ...draft, stage: e.target.value as BreakpointStage })
                      }
                    >
                      <MenuItem value="request">{t("rulesPage.requestStageOption")}</MenuItem>
                      <MenuItem value="response">{t("rulesPage.responseStageOption")}</MenuItem>
                    </Select>
                  </Stack>
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
          title={t("rulesPage.deleteBreakpointTitle")}
          message={t("common.confirmDeleteMessage", {
            name: draft.urlPattern || "*",
          })}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirmOpen(false)}
          isConfirming={setRulesMutation.isPending}
        />

        <ConfirmDialog
          open={batchDeleteConfirmOpen}
          title={t("rulesPage.batch.deleteConfirmTitle")}
          message={t("rulesPage.batch.deleteConfirmMessage", { count: selectedRuleIds.size })}
          onConfirm={confirmBatchDelete}
          onCancel={() => setBatchDeleteConfirmOpen(false)}
          isConfirming={setRulesMutation.isPending}
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
            disabled={setRulesMutation.isPending}
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
