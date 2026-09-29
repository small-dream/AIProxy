import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import FileOpenRoundedIcon from "@mui/icons-material/FileOpenRounded";
import MoreVertRoundedIcon from "@mui/icons-material/MoreVert";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { coerceAppError, type RuleMatch, type ScriptRule } from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

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
  applyOrderedIdsWithinList,
  computeReorderedPriorities,
  moveRuleInOrder,
  nextAppendedPriority,
  resolveNewRulePriority,
} from "@/features/rules/rules-priority.helpers";
import {
  createEmptyScriptRule,
  formatRuleMatch,
  getScriptValidationErrors,
  hasRuleFieldErrors,
  HTTP_METHODS,
  isScriptRuleEqual,
  type RulesPanelHandle,
  ruleFieldProps,
} from "@/features/rules/rules.helpers";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { isMacPlatform } from "@/components/layout/hooks/helpers";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import {
  SCRIPT_RULES_QUERY_KEY,
  useBulkUpdateRules,
  useDeleteManagedRule,
  useSaveScriptRule,
  useScriptRules,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";
import { deleteRule, pickAndReadScriptFile } from "@/services/commands";
import { useNotificationStore } from "@/services/notification.store";
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

export const ScriptRulesPanel = forwardRef<RulesPanelHandle>(
  function ScriptRulesPanel(_props, ref) {
    const { t } = useI18n();
    // Platform-aware glyph for the Save tooltip (⌘S on macOS, Ctrl+S elsewhere).
    const saveShortcutLabel = isMacPlatform() ? "⌘S" : "Ctrl+S";
    const queryClient = useQueryClient();
    const { data: rules = [], isError: isRulesError } = useScriptRules();
    const saveMutation = useSaveScriptRule();
    const deleteMutation = useDeleteManagedRule();
    const bulkMutation = useBulkUpdateRules();
    const [searchValue, setSearchValue] = useState("");
    const [selectedRuleId, setSelectedRuleId] = useState<string>();
    const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
    const [actionsMenuAnchor, setActionsMenuAnchor] = useState<HTMLElement | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
    const [draft, setDraft] = useState<ScriptRule>(createEmptyScriptRule());
    const [validationAttempted, setValidationAttempted] = useState(false);
    // Priority handed to the current draft while it is still unsaved, so the
    // save path can re-derive "append at the end" against the list as it looks
    // THEN (see resolveNewRulePriority).
    const autoPriorityRef = useRef<number | null>(null);
    // M22/M25: track the last id we synced a draft FROM, so a TanStack Query
    // refetch (new `rules[]`/`filteredRules[]` array identity) does NOT re-run
    // the draft-sync and clobber an in-flight edit or an in-flight import. The
    // sync effect now fires only when the selected id actually changes. Mirrors
    // the `lastSyncedRuleIdRef` guard in `use-throttle-editor.ts`.
    const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);

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
      // M22/M25: only auto-select when the selection is actually empty or stale,
      // and only sync the draft when the selected id actually changes — NOT on
      // every rules[] refetch (new filteredRules/rules array identity). This
      // protects in-flight edits and imports from being clobbered.
      const selectionValid =
        selectedRuleId &&
        (rules.some((rule) => rule.id === selectedRuleId) || draft.id === selectedRuleId);
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
    // saved rule for an existing selection, or an empty rule for a new/seeded
    // draft. Mirrors the rewrite editor.
    const selectedSavedRule = useMemo(
      () => rules.find((rule) => rule.id === selectedRuleId),
      [rules, selectedRuleId],
    );
    const isDirty = useMemo(() => {
      const baseline = selectedSavedRule ?? createEmptyScriptRule(draft.language);
      return !isScriptRuleEqual(draft, baseline);
    }, [draft, selectedSavedRule]);

    // Guards route navigation away AND in-component transitions that would
    // replace the in-flight draft; both share one confirmation dialog.
    const guard = useUnsavedChangesGuard(isDirty);

    useImperativeHandle(ref, () => ({ isDirty, confirmLeave: guard.confirmLeave }), [
      guard.confirmLeave,
      isDirty,
    ]);

    async function selectRule(rule: ScriptRule) {
      if (!(await guard.confirmLeave())) return;
      lastSyncedRuleIdRef.current = rule.id;
      setSelectedRuleId(rule.id);
      setDraft(rule);
      setValidationAttempted(false);
    }

    async function handleCreate(template?: "header" | "mock" | "extract") {
      if (!(await guard.confirmLeave())) return;
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
      // New rules append at the END of the list; that priority is resolved at
      // save time so the untouched draft still matches its empty-rule baseline.
      autoPriorityRef.current = next.priority;
      lastSyncedRuleIdRef.current = next.id;
      setSelectedRuleId(next.id);
      setDraft(next);
      setTemplateDialogOpen(false);
      setValidationAttempted(false);
    }

    async function handleDuplicateRule() {
      if (!(await guard.confirmLeave())) return;
      const priority = nextAppendedPriority(rules.map((rule) => rule.priority));
      const copy: ScriptRule = {
        ...draft,
        id: crypto.randomUUID(),
        name: `${draft.name.trim() || t("rulesPage.untitledRule")}${t("rulesPage.copySuffix")}`,
        priority,
        match: { ...draft.match, methods: [...draft.match.methods] },
        entrypoints: { ...draft.entrypoints },
      };
      autoPriorityRef.current = priority;
      lastSyncedRuleIdRef.current = copy.id;
      setSelectedRuleId(copy.id);
      setDraft(copy);
      setValidationAttempted(false);
    }

    async function handleImportFile() {
      try {
        // H10 (closed): the backend owns the OS file dialog. The renderer supplies
        // only a localized title; the Rust side drives the picker, reads the
        // chosen file, and returns its contents (null = user cancelled).
        const imported = await pickAndReadScriptFile(t("rulesPage.script.importFile"));
        if (!imported) {
          return;
        }
        // M25: pre-mark the current selection as synced so a refetch landing
        // between the two awaits does not trigger the selection effect to
        // overwrite the imported source with the server value.
        lastSyncedRuleIdRef.current = selectedRuleId ?? draft.id;
        setDraft((current) => ({
          ...current,
          language: imported.language,
          name: current.name || imported.fileName.replace(/\.[^.]+$/, ""),
          sourceCode: imported.sourceCode,
          sourcePath: imported.path,
          sourceType: "fileImport",
        }));
      } catch (error) {
        // The command layer logs the failure, but the user also needs a visible
        // signal — otherwise a bad file pick silently leaves the editor empty.
        const message = coerceAppError(error).message;
        useNotificationStore.getState().push(t("rulesPage.script.importFailed", { message }));
      }
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
            lastSyncedRuleIdRef.current = saved.id;
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
      if (!selectedRuleId || !rules.some((rule) => rule.id === selectedRuleId)) {
        lastSyncedRuleIdRef.current = undefined;
        setSelectedRuleId(undefined);
        setDraft(createEmptyScriptRule());
        setValidationAttempted(false);
        return;
      }
      // Destructive: confirm before the persisted rule is removed.
      setDeleteConfirmOpen(true);
    }

    function confirmDelete() {
      if (!selectedRuleId) return;
      deleteMutation.mutate(
        { ruleId: selectedRuleId, ruleType: "script" },
        {
          onSuccess: () => {
            lastSyncedRuleIdRef.current = undefined;
            setSelectedRuleId(undefined);
            setDraft(createEmptyScriptRule());
            setValidationAttempted(false);
            setDeleteConfirmOpen(false);
          },
        },
      );
    }

    const errors = getScriptValidationErrors(draft, t);
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
        { ruleType: "script", updates },
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
      void Promise.allSettled(ids.map((ruleId) => deleteRule({ ruleId, ruleType: "script" }))).then(
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
        .filter((rule): rule is ScriptRule => rule !== undefined);
      queryClient.setQueryData(SCRIPT_RULES_QUERY_KEY, reordered);
      bulkMutation.mutate(
        { ruleType: "script", updates },
        {
          onError: () => {
            queryClient.setQueryData(SCRIPT_RULES_QUERY_KEY, previous);
            queryClient.invalidateQueries({ queryKey: SCRIPT_RULES_QUERY_KEY });
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

    const scriptTemplates = [
      {
        description: t("rulesPage.script.templates.headerDescription"),
        label: t("rulesPage.script.templates.header"),
        template: "header" as const,
      },
      {
        description: t("rulesPage.script.templates.mockDescription"),
        label: t("rulesPage.script.templates.mock"),
        template: "mock" as const,
      },
      {
        description: t("rulesPage.script.templates.extractDescription"),
        label: t("rulesPage.script.templates.extract"),
        template: "extract" as const,
      },
    ];

    // One consolidated create entry: primary "New Script Rule", secondary
    // "Templates" (gallery dialog), and Import File demoted to a quiet text
    // button. Shared by the header row and the list's empty state.
    const createEntryButtons = (
      <>
        <Button
          size="small"
          variant="contained"
          disabled={isRulesError}
          startIcon={<AddRoundedIcon />}
          onClick={() => handleCreate()}
        >
          {t("rulesPage.script.createRule")}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={isRulesError}
          onClick={() => setTemplateDialogOpen(true)}
        >
          {t("rulesPage.script.templatesButton")}
        </Button>
        <Button
          size="small"
          variant="text"
          disabled={isRulesError}
          startIcon={<FileOpenRoundedIcon />}
          onClick={() => {
            void handleImportFile();
          }}
          sx={{ color: "text.secondary" }}
        >
          {t("rulesPage.script.importFile")}
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
          searchPlaceholder={t("rulesPage.script.searchPlaceholder")}
          listControlsHidden={rules.length === 0}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          createActions={createEntryButtons}
          list={
            <ManagedRuleList
              emptyActions={createEntryButtons}
              emptyDescription={t("rulesPage.script.emptyDescription")}
              onReorder={handleReorder}
              selectedIds={selectedRuleIds}
              items={filteredRules.map((rule) => ({
                id: rule.id,
                active: rule.id === selectedRuleId,
                enabled: rule.enabled,
                name: rule.name || t("rulesPage.untitledRule"),
                subtitle: `${formatRuleMatch(rule.match)} • ${rule.language.toUpperCase()}`,
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

              <RuleSection>
                <FieldGroup title={t("rulesPage.editor.matchTitle")}>
                  <TextField
                    size="small"
                    label={formatRuleFieldLabel(t("rulesPage.editor.urlPattern"), "required", t)}
                    value={draft.match.urlPattern}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        match: { ...draft.match, urlPattern: event.target.value },
                      })
                    }
                    {...ruleFieldProps(errors, validationAttempted, "match.urlPattern")}
                    placeholder={t("rulesPage.editor.urlPatternExample")}
                    fullWidth
                  />
                  <MatchTypeSelect
                    value={draft.match.matchType}
                    onChange={(matchType) =>
                      setDraft({ ...draft, match: { ...draft.match, matchType } })
                    }
                  />
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontWeight: 650,
                        }}
                      >
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
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontWeight: 650,
                        }}
                      >
                        {formatRuleFieldLabel(t("rulesPage.editor.matchStage"), "required", t)}
                      </Typography>
                      <Select
                        size="small"
                        value={draft.match.stage}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            match: {
                              ...draft.match,
                              stage: event.target.value as RuleMatch["stage"],
                            },
                          })
                        }
                      >
                        <MenuItem value="either">{t("rulesPage.editor.matchStageEither")}</MenuItem>
                        <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                        <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                      </Select>
                    </Stack>
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontWeight: 650,
                        }}
                      >
                        {formatRuleFieldLabel(t("rulesPage.script.language"), "required", t)}
                      </Typography>
                      <Select
                        size="small"
                        value={draft.language}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            language: event.target.value as ScriptRule["language"],
                          })
                        }
                      >
                        <MenuItem value="typescript">TypeScript</MenuItem>
                        <MenuItem value="javascript">JavaScript</MenuItem>
                      </Select>
                    </Stack>
                  </Stack>
                  {draft.sourcePath && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
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
                    {...ruleFieldProps(errors, validationAttempted, "sourceCode")}
                    sx={{
                      "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 },
                    }}
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
            name: draft.name.trim() || draft.match.urlPattern,
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

        <Dialog
          fullWidth
          maxWidth="sm"
          open={templateDialogOpen}
          onClose={() => setTemplateDialogOpen(false)}
        >
          <DialogTitle>{t("rulesPage.script.templatesTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1} sx={{ pb: 1 }}>
              {scriptTemplates.map((template) => (
                <Button
                  key={template.template}
                  color="inherit"
                  onClick={() => handleCreate(template.template)}
                  size="small"
                  startIcon={<CodeRoundedIcon fontSize="small" />}
                  sx={{
                    alignItems: "flex-start",
                    border: 1,
                    borderColor: "divider",
                    justifyContent: "flex-start",
                    px: 1,
                    py: 0.85,
                    textAlign: "left",
                  }}
                >
                  <Stack spacing={0.15}>
                    <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 700 }}>
                      {template.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {template.description}
                    </Typography>
                  </Stack>
                </Button>
              ))}
            </Stack>
          </DialogContent>
        </Dialog>
      </>
    );
  },
);
