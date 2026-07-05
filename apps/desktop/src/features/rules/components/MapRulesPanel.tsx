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
import type { MapRule } from "@aiproxy/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createEmptyMapRule, getMapValidationErrors } from "@/features/rules/rules.helpers";
import {
  FieldGroup,
  formatRuleFieldLabel,
  InlineSwitch,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleSection,
} from "@/features/rules/components/RulesSharedUi";
import {
  useDeleteManagedRule,
  useMapRules,
  useSaveMapRule,
} from "@/features/rules/use-rule-center";
import { useI18n } from "@/i18n";

export function MapRulesPanel({ mode }: { mode: MapRule["mode"] }) {
  const { t } = useI18n();
  const { data: rules = [], isError: isRulesError } = useMapRules(mode);
  const saveMutation = useSaveMapRule();
  const deleteMutation = useDeleteManagedRule();
  const [searchValue, setSearchValue] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [draft, setDraft] = useState<MapRule>(createEmptyMapRule(mode));
  const [validationAttempted, setValidationAttempted] = useState(false);
  // M22: track the last id we synced a draft FROM, so a TanStack Query refetch
  // (new rules[]/filteredRules[] array identity) does NOT re-run the draft-
  // sync and clobber an in-flight edit. Mirrors `use-throttle-editor.ts`.
  const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);
  // L3: priority is committed from a local text draft so clearing the field
  // doesn't instantly snap to 0 mid-edit (the old `Number(value) || 0`). Mirrors
  // ProfileEditor.
  const [priorityText, setPriorityText] = useState(String(draft.priority));
  useEffect(() => {
    if (draft.priority !== Number(priorityText)) {
      setPriorityText(String(draft.priority));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.priority]);

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

  function selectRule(rule: MapRule) {
    lastSyncedRuleIdRef.current = rule.id;
    setSelectedRuleId(rule.id);
    setDraft(rule);
    setValidationAttempted(false);
  }

  function handleCreateRule() {
    const d = createEmptyMapRule(mode);
    lastSyncedRuleIdRef.current = d.id;
    setSelectedRuleId(d.id);
    setDraft(d);
    setValidationAttempted(false);
  }

  function handleSave() {
    if (isRulesError) return;
    setValidationAttempted(true);
    if (errors.length > 0) return;
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
    deleteMutation.mutate(
      { ruleId: selectedRuleId, ruleType: "map" },
      {
        onSuccess: () => {
          lastSyncedRuleIdRef.current = undefined;
          setSelectedRuleId(undefined);
          setDraft(createEmptyMapRule(mode));
          setValidationAttempted(false);
        },
      },
    );
  }

  const errors = getMapValidationErrors(draft, t);
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

  return (
    <>
      {isRulesError && (
        <Alert severity="error" sx={{ mb: 1 }}>{t("common.errors.generic")}</Alert>
      )}
      <ManagedRulesWorkbench
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
              pb: 1.5
            }}>
            <TextField
              size="small"
              label={formatRuleFieldLabel(t("rulesPage.editor.ruleName"), "required", t)}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
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
                px: 1
              }}>
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>
                {t("rulesPage.editor.enabled")}
              </Typography>
              <Switch
                size="small"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
            </Stack>
            <TextField
              size="small"
              type="number"
              label={formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t)}
              value={priorityText}
              onChange={(e) => {
                setPriorityText(e.target.value);
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed) && e.target.value.trim() !== "") {
                  setDraft({ ...draft, priority: parsed });
                }
              }}
              onBlur={() => {
                const parsed = Number(priorityText);
                const next = Number.isFinite(parsed) && priorityText.trim() !== "" ? parsed : 0;
                setPriorityText(String(next));
                if (draft.priority !== next) setDraft({ ...draft, priority: next });
              }}
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

          {/* Validation */}
          {validationAttempted && errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
              <Stack spacing={0.25}>
                {errors.map((err) => (
                  <Typography key={err} variant="body2">
                    {err}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}

          {/* Mapping config */}
          <RuleSection>
            <FieldGroup title={t("rulesPage.mapEditor.matchTitle")}>
              <TextField
                size="small"
                label={formatRuleFieldLabel(t("rulesPage.mapEditor.sourcePattern"), "required", t)}
                value={draft.sourcePattern}
                onChange={(e) => setDraft({ ...draft, sourcePattern: e.target.value })}
                placeholder={t("rulesPage.mapEditor.sourcePatternExample")}
                fullWidth
              />
              <TextField
                size="small"
                label={formatRuleFieldLabel(
                  isLocal ? t("rulesPage.mapLocal.targetPath") : t("rulesPage.mapRemote.targetUrl"),
                  "required",
                  t,
                )}
                value={draft.targetValue}
                onChange={(e) => setDraft({ ...draft, targetValue: e.target.value })}
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
                                    <FolderOpenRoundedIcon sx={{ fontSize: 18, opacity: 0.6 }} />
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
    </>
  );
}
