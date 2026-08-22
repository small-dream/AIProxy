import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import { coerceAppError, type MapRule, type SessionSummary } from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { deleteRule } from "@/services/commands";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useNotificationStore } from "@/services/notification.store";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import { PriorityField } from "@/features/rules/components/PriorityField";
import { RuleBatchBar } from "@/features/rules/components/RulesSharedUi";
import {
  createEmptyMapRule,
  getMapValidationErrors,
  hasRuleFieldErrors,
  isMapRuleEqual,
  type RulesPanelHandle,
  ruleFieldProps,
} from "@/features/rules/rules.helpers";
import {
  FieldGroup,
  formatRuleFieldLabel,
  InlineSwitch,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleSection,
} from "@/features/rules/components/RulesSharedUi";
import { computeReorderedPriorities } from "@/features/rules/rules-priority.helpers";
import {
  MAP_RULES_QUERY_KEY,
  useBulkUpdateRules,
  useDeleteManagedRule,
  useMapRules,
  useSaveMapRule,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

type MapLocalSeed = Pick<SessionSummary, "host" | "method" | "path" | "url">;
type RulesLocationState = { mapLocalSeed?: MapLocalSeed } | null;

function createSeededMapRule(seed: MapLocalSeed, mode: MapRule["mode"]): MapRule {
  const rule = createEmptyMapRule(mode);
  const pattern =
    seed.host && seed.path ? `${seed.host}${seed.path === "/" ? "" : seed.path}` : seed.url;

  return {
    ...rule,
    name: `Map Local ${seed.host || "request"}`,
    sourcePattern: pattern || seed.url,
  };
}

export const MapRulesPanel = forwardRef<RulesPanelHandle, { mode: MapRule["mode"] }>(
  function MapRulesPanel({ mode }, ref) {
    const { t } = useI18n();
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const { data: rules = [], isError: isRulesError } = useMapRules(mode);
    const saveMutation = useSaveMapRule();
    const deleteMutation = useDeleteManagedRule();
    const bulkMutation = useBulkUpdateRules();
    const [searchValue, setSearchValue] = useState("");
    const [selectedRuleId, setSelectedRuleId] = useState<string>();
    const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [draft, setDraft] = useState<MapRule>(createEmptyMapRule(mode));
    const [validationAttempted, setValidationAttempted] = useState(false);
    // M22: track the last id we synced a draft FROM, so a TanStack Query refetch
    // (new rules[]/filteredRules[] array identity) does NOT re-run the draft-
    // sync and clobber an in-flight edit. Mirrors `use-throttle-editor.ts`.
    const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);

    // M-rules: when the user triggers "Map Local" from a captured request, the
    // sessions page navigates here with a mapLocalSeed; pre-fill the draft with
    // the request's host+path so the user only picks the local file. Only local
    // mode consumes the seed (remote/DNS mode ignores it).
    useEffect(() => {
      const state = location.state as RulesLocationState;
      if (!state?.mapLocalSeed || mode !== "local") return;

      const seededRule = createSeededMapRule(state.mapLocalSeed, mode);
      lastSyncedRuleIdRef.current = seededRule.id;
      setSelectedRuleId(seededRule.id);
      setDraft(seededRule);
      setValidationAttempted(false);
      navigate(location.pathname, { replace: true, state: null });
    }, [location.pathname, location.state, mode, navigate]);

    const filteredRules = useMemo(() => {
      const q = searchValue.trim().toLowerCase();
      return [...rules]
        .sort((a, b) => b.priority - a.priority)
        .filter((r) => {
          if (!q) return true;
          return `${r.name} ${r.sourcePattern} ${r.targetValue}`.toLowerCase().includes(q);
        });
    }, [rules, searchValue]);

    useEffect(() => {
      if (draft.mode !== mode) {
        lastSyncedRuleIdRef.current = undefined;
        setDraft(createEmptyMapRule(mode));
        setSelectedRuleId(undefined);
        setValidationAttempted(false);
      }
    }, [draft.mode, mode]);

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
    // saved rule for an existing selection, or an empty rule for a new/seeded
    // draft. Mirrors the rewrite editor.
    const selectedSavedRule = useMemo(
      () => rules.find((rule) => rule.id === selectedRuleId),
      [rules, selectedRuleId],
    );
    const isDirty = useMemo(() => {
      const baseline = selectedSavedRule ?? createEmptyMapRule(mode);
      return !isMapRuleEqual(draft, baseline);
    }, [draft, mode, selectedSavedRule]);

    // Guards route navigation away AND in-component transitions that would
    // replace the in-flight draft; both share one confirmation dialog.
    const guard = useUnsavedChangesGuard(isDirty);

    useImperativeHandle(ref, () => ({ isDirty, confirmLeave: guard.confirmLeave }), [
      guard.confirmLeave,
      isDirty,
    ]);

    async function selectRule(rule: MapRule) {
      if (!(await guard.confirmLeave())) return;
      lastSyncedRuleIdRef.current = rule.id;
      setSelectedRuleId(rule.id);
      setDraft(rule);
      setValidationAttempted(false);
    }

    async function handleCreateRule() {
      if (!(await guard.confirmLeave())) return;
      const d = createEmptyMapRule(mode);
      lastSyncedRuleIdRef.current = d.id;
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
          lastSyncedRuleIdRef.current = saved.id;
          setSelectedRuleId(saved.id);
          setDraft(saved);
          setValidationAttempted(false);
        },
      });
    }

    function handleDelete() {
      if (isRulesError) return;
      if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
        lastSyncedRuleIdRef.current = undefined;
        setDraft(createEmptyMapRule(mode));
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
        { ruleId: selectedRuleId, ruleType: "map" },
        {
          onSuccess: () => {
            lastSyncedRuleIdRef.current = undefined;
            setSelectedRuleId(undefined);
            setDraft(createEmptyMapRule(mode));
            setValidationAttempted(false);
            setDeleteConfirmOpen(false);
          },
        },
      );
    }

    const errors = getMapValidationErrors(draft, t);
    const saveError = saveMutation.error ? coerceAppError(saveMutation.error).message : undefined;
    const isLocal = mode === "local";

    const handlePickFile = useCallback(async () => {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("rulesPage.mapLocal.pickFile"),
      });
      if (selected) {
        setDraft((d) => ({ ...d, targetValue: selected }));
      }
    }, [t]);

    const handlePickFolder = useCallback(async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("rulesPage.mapLocal.pickFolder"),
      });
      if (selected) {
        setDraft((d) => ({ ...d, targetValue: selected }));
      }
    }, [t]);

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
        { ruleType: "map", updates },
        {
          onSettled: () => clearSelection(),
        },
      );
    }

    function handleBatchDelete() {
      const ids = [...selectedRuleIds];
      if (ids.length === 0) return;
      void Promise.allSettled(ids.map((ruleId) => deleteRule({ ruleId, ruleType: "map" }))).then(
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
        .filter((rule): rule is MapRule => rule !== undefined);
      queryClient.setQueryData([...MAP_RULES_QUERY_KEY, mode ?? "all"], reordered);
      bulkMutation.mutate(
        { ruleType: "map", updates },
        {
          onError: () => {
            queryClient.setQueryData([...MAP_RULES_QUERY_KEY, mode ?? "all"], previous);
            queryClient.invalidateQueries({ queryKey: MAP_RULES_QUERY_KEY });
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
          searchPlaceholder={
            isLocal
              ? t("rulesPage.mapLocal.searchPlaceholder")
              : t("rulesPage.mapRemote.searchPlaceholder")
          }
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
              {isLocal ? t("rulesPage.mapLocal.createRule") : t("rulesPage.mapRemote.createRule")}
            </Button>
          }
          list={
            <ManagedRuleList
              emptyDescription={
                isLocal
                  ? t("rulesPage.mapLocal.emptyDescription")
                  : t("rulesPage.mapRemote.emptyDescription")
              }
              onReorder={handleReorder}
              selectedIds={selectedRuleIds}
              items={filteredRules.map((rule) => ({
                id: rule.id,
                active: rule.id === selectedRuleId,
                enabled: rule.enabled,
                name: rule.name || t("rulesPage.untitledRule"),
                subtitle: `${rule.sourcePattern || "*"} → ${rule.targetValue || t("rulesPage.notConfigured")}`,
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

              {/* Mapping config */}
              <RuleSection>
                <FieldGroup title={t("rulesPage.mapEditor.matchTitle")}>
                  <TextField
                    size="small"
                    label={formatRuleFieldLabel(
                      t("rulesPage.mapEditor.sourcePattern"),
                      "required",
                      t,
                    )}
                    value={draft.sourcePattern}
                    onChange={(e) => setDraft({ ...draft, sourcePattern: e.target.value })}
                    {...ruleFieldProps(errors, validationAttempted, "sourcePattern")}
                    placeholder={t("rulesPage.mapEditor.sourcePatternExample")}
                    fullWidth
                  />
                  <MatchTypeSelect
                    value={draft.matchType}
                    onChange={(matchType) => setDraft({ ...draft, matchType })}
                  />
                  <TextField
                    size="small"
                    label={formatRuleFieldLabel(
                      isLocal
                        ? t("rulesPage.mapLocal.targetPath")
                        : t("rulesPage.mapRemote.targetUrl"),
                      "required",
                      t,
                    )}
                    value={draft.targetValue}
                    onChange={(e) => setDraft({ ...draft, targetValue: e.target.value })}
                    {...ruleFieldProps(errors, validationAttempted, "targetValue")}
                    placeholder={
                      isLocal
                        ? t("rulesPage.mapLocal.targetPathExample")
                        : t("rulesPage.mapRemote.targetUrlExample")
                    }
                    fullWidth
                    slotProps={
                      isLocal
                        ? {
                            input: {
                              endAdornment: (
                                <InputAdornment position="end" sx={{ mr: -0.5 }}>
                                  <Stack direction="row" spacing={0.25}>
                                    <Tooltip title={t("rulesPage.mapLocal.pickFile")}>
                                      <IconButton size="small" onClick={handlePickFile}>
                                        <FolderOpenRoundedIcon sx={{ fontSize: 18 }} />
                                      </IconButton>
                                    </Tooltip>
                                    <Tooltip title={t("rulesPage.mapLocal.pickFolder")}>
                                      <IconButton size="small" onClick={handlePickFolder}>
                                        <FolderOpenRoundedIcon
                                          sx={{ fontSize: 18, opacity: 0.6 }}
                                        />
                                      </IconButton>
                                    </Tooltip>
                                  </Stack>
                                </InputAdornment>
                              ),
                            },
                          }
                        : undefined
                    }
                  />
                  <Stack direction="row" spacing={2}>
                    <InlineSwitch
                      label={t("rulesPage.mapEditor.preservePath")}
                      checked={draft.preservePath}
                      onChange={(v) => setDraft({ ...draft, preservePath: v })}
                    />
                    <InlineSwitch
                      label={t("rulesPage.mapEditor.preserveQuery")}
                      checked={draft.preserveQuery}
                      onChange={(v) => setDraft({ ...draft, preserveQuery: v })}
                    />
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
          title={t("rulesPage.deleteRuleTitle")}
          message={t("common.confirmDeleteMessage", {
            name: draft.name.trim() || draft.sourcePattern,
          })}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirmOpen(false)}
          isConfirming={deleteMutation.isPending}
        />
      </>
    );
  },
);
