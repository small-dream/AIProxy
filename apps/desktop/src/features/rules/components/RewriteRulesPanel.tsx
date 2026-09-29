import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import BugReportRoundedIcon from "@mui/icons-material/BugReportRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import DoNotDisturbOnRoundedIcon from "@mui/icons-material/DoNotDisturbOnRounded";
import KeyboardRoundedIcon from "@mui/icons-material/KeyboardRounded";
import MoreVertRoundedIcon from "@mui/icons-material/MoreVert";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { isMacPlatform } from "@/components/layout/hooks/helpers";
import {
  coerceAppError,
  type RewriteAction,
  type RewriteBodyFieldEdit,
  type RewriteRule,
  type RewriteRuleType,
  type RuleMatch,
  type SessionSummary,
} from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";

import { deleteRule } from "@/services/commands";
import { useNotificationStore } from "@/services/notification.store";
import {
  REWRITE_RULES_QUERY_KEY,
  useBulkUpdateRules,
  useDeleteManagedRule,
  useRewriteRules,
  useSaveRewriteRule,
} from "@/features/rules/use-rule-center";
import {
  createEmptyRewriteAction,
  createEmptyRewriteRule,
  formatRuleMatch,
  getRewriteTypeLabel,
  getRewriteValidationErrors,
  hasRuleFieldErrors,
  HTTP_METHODS,
  isRewriteRuleEqual,
  ruleFieldProps,
  wildcardMatch,
  type RuleFieldErrors,
  type TranslationFn,
} from "@/features/rules/rules.helpers";
import {
  AdvancedPriorityField,
  FieldGroup,
  formatRuleFieldLabel,
  InlineSwitch,
  isEditableTarget,
  ManagedRuleList,
  ManagedRulesWorkbench,
  RuleBatchBar,
  RuleEditorIdentity,
  RuleSection,
  EditorActionBar,
  UnsavedChangesIndicator,
  reorderShortcutLabel,
  useClearMutationErrorOnRuleChange,
} from "@/features/rules/components/RulesSharedUi";
import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import {
  applyOrderedIdsWithinList,
  computeReorderedPriorities,
  moveRuleInOrder,
  nextAppendedPriority,
  resolveNewRulePriority,
} from "@/features/rules/rules-priority.helpers";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n, type TranslationKey } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type RewriteSeed = Pick<SessionSummary, "host" | "method" | "path" | "url">;
type RulesLocationState = { rewriteSeed?: RewriteSeed } | null;

type RewriteTemplate = {
  // `label` / `description` are dot-path i18n keys resolved via t() at render
  // time so the template dialog is localized. They double as the stable React
  // key. The seeded rule `name` (inside build()) stays English on purpose: it
  // becomes an editable, persisted field and must not flip with the UI locale.
  description: TranslationKey;
  icon: "bug" | "route" | "tune";
  label: TranslationKey;
  type: RewriteRuleType;
  build: () => RewriteRule;
};

export type RuleTestInput = {
  method: string;
  stage: RuleMatch["stage"];
  url: string;
};

function createSeededRule(seed: RewriteSeed): RewriteRule {
  const rule = createEmptyRewriteRule("header");
  const pattern =
    seed.host && seed.path ? `${seed.host}${seed.path === "/" ? "" : seed.path}` : seed.url;

  return {
    ...rule,
    name: `Debug ${seed.host || "request"}`,
    match: {
      methods: [seed.method.toUpperCase()],
      stage: "request",
      urlPattern: pattern || seed.url,
    },
    actions: [
      {
        rewriteType: "header",
        payload: {
          headerName: "x-debug-mode",
          operation: "set",
          target: "request",
          value: "true",
        },
      },
    ],
  };
}

function stageApplies(ruleStage: RuleMatch["stage"], currentStage: RuleMatch["stage"]) {
  return ruleStage === "either" || ruleStage === currentStage;
}

// The invalid-combination warning links here so users can reach the control
// that usually needs to change.
const MATCH_STAGE_SELECT_ID = "rewrite-match-stage-select";

function focusMatchStageControl() {
  const control = document.getElementById(MATCH_STAGE_SELECT_ID);
  if (control && typeof control.scrollIntoView === "function") {
    control.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  control?.focus();
}

/**
 * Tester verdict. `disabled` separates "the rule is switched off" (fixable by
 * enabling it) from a plain non-match — the two previously shared one gray
 * icon. `blocked` is a third failure mode: the sample matches, but the
 * stage/action combination can never fire, so a green "matched" would lie.
 * A tester stage of "either" tests the rule as authored: the stage
 * constraint is skipped instead of forcing a request/response guess.
 */
type RuleTestVerdict = { ok: boolean; disabled: boolean; blocked: boolean; reason: string };

function testRuleMatch(
  rule: RewriteRule,
  input: RuleTestInput,
  t: TranslationFn,
): Omit<RuleTestVerdict, "blocked"> {
  if (!rule.enabled)
    return {
      ok: false,
      disabled: true,
      reason: t("rulesPage.rewrite.tester.reasons.disabled"),
    };
  if (input.stage !== "either" && !stageApplies(rule.match.stage, input.stage))
    return {
      ok: false,
      disabled: false,
      reason: t("rulesPage.rewrite.tester.reasons.stageMismatch"),
    };
  if (
    rule.match.methods.length > 0 &&
    !rule.match.methods.some((method) => method.toUpperCase() === input.method.toUpperCase())
  ) {
    return {
      ok: false,
      disabled: false,
      reason: t("rulesPage.rewrite.tester.reasons.methodMismatch"),
    };
  }
  if (!wildcardMatch(rule.match.urlPattern, input.url, rule.match.matchType))
    return {
      ok: false,
      disabled: false,
      reason: t("rulesPage.rewrite.tester.reasons.urlMismatch"),
    };
  return { ok: true, disabled: false, reason: t("rulesPage.rewrite.tester.reasons.matched") };
}

/**
 * Full tester verdict: wraps the raw match result with the continuously
 * evaluated invalid-combination check. When the sample matches but the
 * stage/action combination can never fire, the verdict degrades to a
 * distinct warning state instead of a misleading green "matched".
 */
export function resolveRuleTestVerdict(
  rule: RewriteRule,
  input: RuleTestInput,
  invalidCombination: string | undefined,
  t: TranslationFn,
): RuleTestVerdict {
  const base = testRuleMatch(rule, input, t);
  if (base.ok && invalidCombination) {
    return {
      ok: false,
      disabled: false,
      blocked: true,
      reason: t("rulesPage.rewrite.tester.reasons.invalidCombination"),
    };
  }
  return { ...base, blocked: false };
}

function getInvalidRewriteCombination(rule: RewriteRule, t: TranslationFn) {
  if (
    rule.match.stage === "response" &&
    rule.actions.some(
      (action) => action.rewriteType === "query" || action.rewriteType === "redirect",
    )
  ) {
    return t("rulesPage.rewrite.invalidCombination.queryRedirectOnResponse");
  }
  if (
    rule.match.stage === "request" &&
    rule.actions.some(
      (action) => action.rewriteType === "header" && action.payload.target === "response",
    )
  ) {
    return t("rulesPage.rewrite.invalidCombination.headerTargetMismatchRequest");
  }
  if (
    rule.match.stage === "response" &&
    rule.actions.some(
      (action) => action.rewriteType === "header" && action.payload.target === "request",
    )
  ) {
    return t("rulesPage.rewrite.invalidCombination.headerTargetMismatchResponse");
  }
  if (
    rule.match.stage === "request" &&
    rule.actions.some(
      (action) => action.rewriteType === "body" && action.payload.target === "response",
    )
  ) {
    return t("rulesPage.rewrite.invalidCombination.bodyTargetMismatchRequest");
  }
  if (
    rule.match.stage === "response" &&
    rule.actions.some(
      (action) => action.rewriteType === "body" && action.payload.target === "request",
    )
  ) {
    return t("rulesPage.rewrite.invalidCombination.bodyTargetMismatchResponse");
  }
  return undefined;
}

function describeRewriteAction(rule: RewriteRule, t: TranslationFn) {
  const first = rule.actions[0];
  if (rule.actions.length > 1) {
    return t("rulesPage.rewrite.actionsSummary", { count: rule.actions.length });
  }
  if (first?.rewriteType === "header") {
    return t("rulesPage.rewrite.action.header", {
      target: first.payload.target,
      operation: first.payload.operation,
      name: first.payload.headerName || "(name)",
    });
  }
  if (first?.rewriteType === "query") {
    return t("rulesPage.rewrite.action.query", {
      operation: first.payload.operation,
      name: first.payload.paramName || "(param)",
    });
  }
  if (first?.rewriteType === "body") {
    if ((first.payload.mode ?? "replace") === "fields") {
      return t("rulesPage.rewrite.action.bodyFields", {
        target: first.payload.target,
        count: first.payload.fields?.length ?? 0,
      });
    }
    return t("rulesPage.rewrite.action.bodyReplace", {
      target: first.payload.target,
      contentType: first.payload.contentType,
    });
  }
  return t("rulesPage.rewrite.action.redirect", {
    target: first?.payload.targetUrl || "(target URL)",
  });
}

function TemplateIcon({ icon }: { icon: RewriteTemplate["icon"] }) {
  if (icon === "bug") return <BugReportRoundedIcon fontSize="small" />;
  if (icon === "route") return <RouteRoundedIcon fontSize="small" />;
  return <TuneRoundedIcon fontSize="small" />;
}

/** Imperative API for the Rules page: tab switches must ask before the
 * draft (and with it the panel's unmount) is discarded. */
export type RewriteRulesPanelHandle = {
  /** True while the editor draft differs from its saved/empty baseline. */
  isDirty: boolean;
  /** Resolves true when leaving is allowed (not dirty, or user discarded). */
  confirmLeave: () => Promise<boolean>;
};

export const RewriteRulesPanel = forwardRef<RewriteRulesPanelHandle>(
  function RewriteRulesPanel(_props, ref) {
    const { t } = useI18n();
    // Platform-aware glyph for the Save tooltip and the shortcuts dialog.
    const saveShortcutLabel = isMacPlatform() ? "⌘S" : "Ctrl+S";
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const { data: rules = [], isError: isRulesError } = useRewriteRules();
    const saveMutation = useSaveRewriteRule();
    const deleteMutation = useDeleteManagedRule();
    const bulkMutation = useBulkUpdateRules();
    const [searchValue, setSearchValue] = useState("");
    const [selectedRuleId, setSelectedRuleId] = useState<string>();
    const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
    const [actionsMenuAnchor, setActionsMenuAnchor] = useState<HTMLElement | null>(null);
    const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
    const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [draft, setDraft] = useState<RewriteRule>(createEmptyRewriteRule("header"));
    // Priority handed to the current draft while it is still unsaved, so the
    // save path can re-derive "append at the end" against the list as it looks
    // THEN (see resolveNewRulePriority).
    const autoPriorityRef = useRef<number | null>(null);
    const [testInput, setTestInput] = useState<RuleTestInput>({
      method: "GET",
      stage: "request",
      url: "https://api.example.com/v1/users",
    });
    const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
    const [validationAttempted, setValidationAttempted] = useState(false);
    // M22: track the last id we synced a draft FROM, so a TanStack Query refetch
    // (new rules[]/filteredRules[] array identity) does NOT re-run the draft-
    // sync and clobber an in-flight edit. Mirrors `use-throttle-editor.ts`.
    const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);

    const templates = useMemo<RewriteTemplate[]>(
      () => [
        {
          build: () => {
            const rule = createEmptyRewriteRule("header");
            return {
              ...rule,
              match: { methods: [], stage: "either", urlPattern: "*" },
              name: "Add debug header",
              actions: [
                {
                  rewriteType: "header",
                  payload: {
                    headerName: "x-debug-mode",
                    operation: "set",
                    target: "request",
                    value: "true",
                  },
                },
              ],
            };
          },
          description: "rulesPage.rewrite.templates.debugHeader.description",
          icon: "bug",
          label: "rulesPage.rewrite.templates.debugHeader.label",
          type: "header",
        },
        {
          build: () => {
            const rule = createEmptyRewriteRule("header");
            return {
              ...rule,
              match: { methods: [], stage: "response", urlPattern: "*" },
              name: "Disable response cache",
              actions: [
                {
                  rewriteType: "header",
                  payload: {
                    headerName: "Cache-Control",
                    operation: "set",
                    target: "response",
                    value: "no-store",
                  },
                },
              ],
            };
          },
          description: "rulesPage.rewrite.templates.disableCache.description",
          icon: "tune",
          label: "rulesPage.rewrite.templates.disableCache.label",
          type: "header",
        },
        {
          build: () => {
            const rule = createEmptyRewriteRule("query");
            return {
              ...rule,
              match: { methods: [], stage: "request", urlPattern: "*" },
              name: "Route query to staging",
              actions: [
                {
                  rewriteType: "query",
                  payload: { operation: "set", paramName: "env", value: "staging" },
                },
              ],
            };
          },
          description: "rulesPage.rewrite.templates.envQuery.description",
          icon: "route",
          label: "rulesPage.rewrite.templates.envQuery.label",
          type: "query",
        },
        {
          build: () => {
            const rule = createEmptyRewriteRule("redirect");
            return {
              ...rule,
              match: { methods: [], stage: "request", urlPattern: "api.example.com/*" },
              name: "Redirect API to staging",
              actions: [
                {
                  rewriteType: "redirect",
                  payload: {
                    preservePath: true,
                    preserveQuery: true,
                    targetUrl: "https://staging.example.com",
                  },
                },
              ],
            };
          },
          description: "rulesPage.rewrite.templates.stagingRedirect.description",
          icon: "route",
          label: "rulesPage.rewrite.templates.stagingRedirect.label",
          type: "redirect",
        },
        {
          build: () => {
            const rule = createEmptyRewriteRule("body");
            return {
              ...rule,
              match: { methods: [], stage: "response", urlPattern: "*" },
              name: "Mock JSON response",
              actions: [
                {
                  rewriteType: "body",
                  payload: {
                    contentType: "application/json",
                    fields: [],
                    mode: "replace",
                    target: "response",
                    text: '{\n  "ok": true\n}',
                  },
                },
              ],
            };
          },
          description: "rulesPage.rewrite.templates.mockJson.description",
          icon: "tune",
          label: "rulesPage.rewrite.templates.mockJson.label",
          type: "body",
        },
      ],
      [],
    );

    const filteredRules = useMemo(() => {
      const q = searchValue.trim().toLowerCase();
      return [...rules]
        .sort((a, b) => b.priority - a.priority)
        .filter((r) => {
          if (!q) return true;
          return `${r.name} ${r.match.urlPattern} ${r.rewriteType}`.toLowerCase().includes(q);
        });
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

    // P0-2: the draft is "dirty" when it differs from its baseline — the saved
    // rule for an existing selection, or an empty rule for a new/seeded draft.
    const selectedSavedRule = useMemo(
      () => rules.find((rule) => rule.id === selectedRuleId),
      [rules, selectedRuleId],
    );
    const isDirty = useMemo(() => {
      const baseline = selectedSavedRule ?? createEmptyRewriteRule(draft.rewriteType);
      return !isRewriteRuleEqual(draft, baseline);
    }, [draft, selectedSavedRule]);

    // Guards route navigation away AND in-component transitions that would
    // replace the in-flight draft; both share one confirmation dialog.
    const guard = useUnsavedChangesGuard(isDirty);

    useImperativeHandle(ref, () => ({ isDirty, confirmLeave: guard.confirmLeave }), [
      guard.confirmLeave,
      isDirty,
    ]);

    useClearMutationErrorOnRuleChange(saveMutation, selectedRuleId);

    // Consuming a rewriteSeed replaces the in-flight draft, so a dirty editor
    // vetoes through the same guard as every other draft-discarding transition
    // (mirrors the mapLocalSeed flow in MapRulesPanel). Keyed by the history
    // entry so a vetoed seed is not re-prompted on every later re-render; a
    // veto leaves the seed in history state, unconsumed.
    const lastHandledSeedKeyRef = useRef<string | null>(null);
    const seedHandlingRef = useRef(false);
    // Destructured so the effect can depend on the stable callback directly
    // instead of the per-render `guard` object.
    const confirmLeave = guard.confirmLeave;
    useEffect(() => {
      const state = location.state as RulesLocationState;
      if (!state?.rewriteSeed) return;
      if (lastHandledSeedKeyRef.current === location.key) return;
      if (seedHandlingRef.current) return;
      seedHandlingRef.current = true;

      const seed = state.rewriteSeed;
      void (async () => {
        if (!(await confirmLeave())) {
          seedHandlingRef.current = false;
          return;
        }
        const seededRule = createSeededRule(seed);
        // Seeded drafts keep their own priority: only create / duplicate /
        // template drafts are auto-appended by the save path.
        autoPriorityRef.current = null;
        // M22: pre-mark as synced so the selection effect does not overwrite
        // the seeded draft on the next rules[] refetch.
        lastSyncedRuleIdRef.current = seededRule.id;
        setSelectedRuleId(seededRule.id);
        setDraft(seededRule);
        setValidationAttempted(false);
        setTestInput({
          method: seed.method,
          stage: "request",
          url: seed.url,
        });
        lastHandledSeedKeyRef.current = location.key;
        seedHandlingRef.current = false;
        navigate(location.pathname, { replace: true, state: null });
      })();
    }, [location.pathname, location.state, location.key, navigate, confirmLeave]);

    async function selectRule(rule: RewriteRule) {
      if (!(await guard.confirmLeave())) return;
      lastSyncedRuleIdRef.current = rule.id;
      setSelectedRuleId(rule.id);
      setDraft(rule);
      setValidationAttempted(false);
    }

    async function handleCreateRule() {
      if (!(await guard.confirmLeave())) return;
      const d = createEmptyRewriteRule("header");
      d.name = t("rulesPage.rewrite.newRuleDefaultName");
      // New rules append at the END of the list: the draft keeps the neutral
      // default for now and resolveNewRulePriority derives the real value at
      // save time, so a reorder in between cannot strand it mid-list.
      autoPriorityRef.current = d.priority;
      lastSyncedRuleIdRef.current = d.id;
      setSelectedRuleId(d.id);
      setDraft(d);
      setValidationAttempted(false);
    }

    async function handleDuplicateRule() {
      if (!(await guard.confirmLeave())) return;
      const priority = nextAppendedPriority(rules.map((rule) => rule.priority));
      const copy: RewriteRule = {
        ...draft,
        id: crypto.randomUUID(),
        name: `${draft.name.trim() || t("rulesPage.untitledRule")}${t("rulesPage.copySuffix")}`,
        priority,
        match: { ...draft.match, methods: [...draft.match.methods] },
        actions: structuredClone(draft.actions),
      };
      autoPriorityRef.current = priority;
      lastSyncedRuleIdRef.current = copy.id;
      setSelectedRuleId(copy.id);
      setDraft(copy);
      setValidationAttempted(false);
    }

    async function applyTemplate(template: RewriteTemplate) {
      if (!(await guard.confirmLeave())) return;
      const next = template.build();
      next.priority = nextAppendedPriority(rules.map((rule) => rule.priority));
      autoPriorityRef.current = next.priority;
      lastSyncedRuleIdRef.current = next.id;
      setSelectedRuleId(next.id);
      setDraft(next);
      setTemplateDialogOpen(false);
      setValidationAttempted(false);
    }

    function handleSave() {
      if (isRulesError) return;
      setValidationAttempted(true);
      if (hasRuleFieldErrors(errors)) return;
      // UI_GUIDELINES §9.4: a combination that can never fire must not be
      // persisted; the warning Alert above the form explains why.
      if (invalidCombination) return;
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
      if (!selectedRuleId || !rules.some((r) => r.id === selectedRuleId)) {
        lastSyncedRuleIdRef.current = undefined;
        setDraft(createEmptyRewriteRule());
        setSelectedRuleId(undefined);
        return;
      }
      // Destructive: confirm before the persisted rule is removed.
      setDeleteConfirmOpen(true);
    }

    function confirmDelete() {
      if (!selectedRuleId) return;
      deleteMutation.mutate(
        { ruleId: selectedRuleId, ruleType: "rewrite" },
        {
          onSuccess: () => {
            lastSyncedRuleIdRef.current = undefined;
            setSelectedRuleId(undefined);
            setDraft(createEmptyRewriteRule());
            setDeleteConfirmOpen(false);
          },
        },
      );
    }

    const invalidCombination = getInvalidRewriteCombination(draft, t);
    const errors = getRewriteValidationErrors(draft, t);
    const saveError = saveMutation.error ? coerceAppError(saveMutation.error).message : undefined;
    // Continuous verdict: an impossible stage/action combination degrades a
    // matching sample to a warning instead of a green "matched".
    const testResult = resolveRuleTestVerdict(draft, testInput, invalidCombination, t);
    const httpMethodsLabel = formatRuleFieldLabel(t("rulesPage.labels.httpMethods"), "optional", t);

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
        { ruleType: "rewrite", updates },
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
      void Promise.allSettled(
        ids.map((ruleId) => deleteRule({ ruleId, ruleType: "rewrite" })),
      ).then((results) => {
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
      });
    }

    function handlePickSession(session: SessionSummary) {
      const method = session.method.toUpperCase();
      setTestInput({
        method: (HTTP_METHODS as readonly string[]).includes(method) ? method : testInput.method,
        // A captured session always had a request stage; nothing in
        // SessionSummary distinguishes it further.
        stage: "request",
        url: session.url,
      });
      setSessionPickerOpen(false);
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
        .filter((rule): rule is RewriteRule => rule !== undefined);
      queryClient.setQueryData(REWRITE_RULES_QUERY_KEY, reordered);
      bulkMutation.mutate(
        { ruleType: "rewrite", updates },
        {
          onError: () => {
            queryClient.setQueryData(REWRITE_RULES_QUERY_KEY, previous);
            queryClient.invalidateQueries({ queryKey: REWRITE_RULES_QUERY_KEY });
          },
        },
      );
    }

    // Page-scoped keyboard shortcuts (Rewrite tab unmounts detach them):
    // Cmd/Ctrl+S saves (safe even inside text fields), Cmd/Ctrl+D duplicates,
    // Alt+ArrowUp/ArrowDown reorders the selected rule. Everything except
    // Cmd/Ctrl+S is ignored while focus is in an editable control.
    const shortcutStateRef = useRef({ isDirty, selectedRuleId, filteredRules });
    useEffect(() => {
      shortcutStateRef.current = { isDirty, selectedRuleId, filteredRules };
    }, [isDirty, selectedRuleId, filteredRules]);
    const handleSaveRef = useRef(handleSave);
    useEffect(() => {
      handleSaveRef.current = handleSave;
    });
    const duplicateRuleRef = useRef(handleDuplicateRule);
    useEffect(() => {
      duplicateRuleRef.current = handleDuplicateRule;
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
        if (isMod && event.key.toLowerCase() === "d") {
          event.preventDefault();
          void duplicateRuleRef.current();
          return;
        }
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
          searchPlaceholder={t("rulesPage.rewrite.searchPlaceholder")}
          listControlsHidden={rules.length === 0}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          createActions={
            <>
              <Button
                size="small"
                variant="contained"
                disabled={isRulesError}
                startIcon={<AddRoundedIcon />}
                onClick={() => handleCreateRule()}
              >
                {t("rulesPage.rewrite.newRule")}
              </Button>
              <Button
                size="small"
                variant="outlined"
                disabled={isRulesError}
                onClick={() => setTemplateDialogOpen(true)}
              >
                {t("rulesPage.rewrite.templatesButton")}
              </Button>
            </>
          }
          list={
            <ManagedRuleList
              emptyActions={
                <Stack direction="row" spacing={1} sx={{ justifyContent: "center" }}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={isRulesError}
                    startIcon={<AddRoundedIcon />}
                    onClick={() => handleCreateRule()}
                  >
                    {t("rulesPage.rewrite.newRule")}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={isRulesError}
                    onClick={() => setTemplateDialogOpen(true)}
                  >
                    {t("rulesPage.rewrite.browseTemplates")}
                  </Button>
                </Stack>
              }
              emptyDescription={t("rulesPage.rewrite.emptyDescription")}
              onReorder={handleReorder}
              selectedIds={selectedRuleIds}
              items={filteredRules.map((rule) => ({
                id: rule.id,
                active: rule.id === selectedRuleId,
                enabled: rule.enabled,
                name: rule.name || t("rulesPage.untitledRule"),
                subtitle: `${formatRuleMatch(rule.match)} - ${describeRewriteAction(rule, t)}`,
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
              <RewriteEditorIdentity
                advancedOpen={advancedOpen}
                draft={draft}
                errors={errors}
                onChange={setDraft}
                onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
                validationAttempted={validationAttempted}
              />

              {invalidCombination && (
                <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={1}
                    sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">{invalidCombination}</Typography>
                    <Link
                      component="button"
                      type="button"
                      variant="body2"
                      onClick={focusMatchStageControl}
                      sx={{ flexShrink: 0, fontWeight: 650 }}
                    >
                      {t("rulesPage.rewrite.goToMatchStage")}
                    </Link>
                  </Stack>
                </Alert>
              )}

              {saveError && (
                <Alert severity="error" variant="outlined">
                  {saveError}
                </Alert>
              )}

              <RuleSection>
                <FieldGroup title={t("rulesPage.rewrite.whenSection")}>
                  <TextField
                    size="small"
                    label={t("rulesPage.editor.urlPattern")}
                    value={draft.match.urlPattern}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        match: { ...draft.match, urlPattern: e.target.value },
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
                        id="rewrite-methods-label"
                        sx={{
                          color: "text.secondary",
                          fontWeight: 650,
                        }}
                      >
                        {httpMethodsLabel}
                      </Typography>
                      <Select
                        displayEmpty
                        multiple
                        size="small"
                        labelId="rewrite-methods-label"
                        value={draft.match.methods}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            match: { ...draft.match, methods: e.target.value as string[] },
                          })
                        }
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
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        id="rewrite-match-stage-label"
                        sx={{
                          color: "text.secondary",
                          fontWeight: 650,
                        }}
                      >
                        {t("rulesPage.editor.matchStage")}
                      </Typography>
                      <Select
                        size="small"
                        labelId="rewrite-match-stage-label"
                        SelectDisplayProps={{ id: MATCH_STAGE_SELECT_ID }}
                        value={draft.match.stage}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            match: {
                              ...draft.match,
                              stage: e.target.value as RuleMatch["stage"],
                            },
                          })
                        }
                      >
                        <MenuItem value="either">{t("rulesPage.editor.matchStageEither")}</MenuItem>
                        <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
                        <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
                      </Select>
                    </Stack>
                  </Stack>
                </FieldGroup>
              </RuleSection>

              <RuleSection>
                <FieldGroup title={t("rulesPage.rewrite.thenSection")}>
                  <RewriteActionFields
                    errors={errors}
                    rule={draft}
                    onChange={setDraft}
                    validationAttempted={validationAttempted}
                  />
                </FieldGroup>
              </RuleSection>

              <RewriteRuleTester
                draft={draft}
                invalidCombination={invalidCombination}
                testInput={testInput}
                testResult={testResult}
                onChange={setTestInput}
                onOpenSessionPicker={() => setSessionPickerOpen(true)}
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
                  onClick={() => {
                    setActionsMenuAnchor(null);
                    setShortcutsDialogOpen(true);
                  }}
                >
                  <KeyboardRoundedIcon fontSize="small" sx={{ mr: 1 }} />
                  {t("rulesPage.rewrite.shortcuts.menuItem")}
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
            </Stack>
          }
        />
        <Dialog
          fullWidth
          maxWidth="sm"
          open={templateDialogOpen}
          onClose={() => setTemplateDialogOpen(false)}
        >
          <DialogTitle>{t("rulesPage.rewrite.templatesTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1} sx={{ pb: 1 }}>
              {templates.map((template) => (
                <Button
                  key={template.label}
                  color="inherit"
                  onClick={() => applyTemplate(template)}
                  size="small"
                  startIcon={<TemplateIcon icon={template.icon} />}
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
                    <Stack
                      direction="row"
                      spacing={0.75}
                      sx={{
                        alignItems: "center",
                      }}
                    >
                      <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 700 }}>
                        {t(template.label)}
                      </Typography>
                      <Chip
                        size="small"
                        label={getRewriteTypeLabel(template.type, t)}
                        sx={{ height: 18, fontSize: 10 }}
                      />
                    </Stack>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t(template.description)}
                    </Typography>
                  </Stack>
                </Button>
              ))}
            </Stack>
          </DialogContent>
        </Dialog>

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

        {sessionPickerOpen && (
          <SessionPickerDialog
            open={sessionPickerOpen}
            onClose={() => setSessionPickerOpen(false)}
            onPick={handlePickSession}
          />
        )}

        <RewriteShortcutsDialog
          open={shortcutsDialogOpen}
          onClose={() => setShortcutsDialogOpen(false)}
        />
      </>
    );
  },
);

function RewriteEditorIdentity({
  advancedOpen,
  draft,
  errors,
  onChange,
  onToggleAdvanced,
  validationAttempted,
}: {
  advancedOpen: boolean;
  draft: RewriteRule;
  errors: RuleFieldErrors;
  onChange: (rule: RewriteRule) => void;
  onToggleAdvanced: () => void;
  validationAttempted: boolean;
}) {
  const { t } = useI18n();
  const matchType = draft.match.matchType ?? "contains";
  const scopeHint =
    draft.match.urlPattern.trim() === "*"
      ? t("rulesPage.rewrite.scopeHintAllTraffic")
      : matchType === "regex"
        ? t("rulesPage.rewrite.scopeHintRegex")
        : undefined;

  return (
    <RuleEditorIdentity
      advanced={
        <AdvancedPriorityField
          value={draft.priority}
          onCommit={(priority) => onChange({ ...draft, priority })}
        />
      }
      advancedOpen={advancedOpen}
      enabled={draft.enabled}
      hint={scopeHint}
      name={draft.name}
      nameFieldProps={ruleFieldProps(errors, validationAttempted, "name")}
      onNameChange={(name) => onChange({ ...draft, name })}
      onToggleAdvanced={onToggleAdvanced}
      onToggleEnabled={(enabled) => onChange({ ...draft, enabled })}
    />
  );
}

/**
 * Discoverability for the page-level shortcuts (P1a): the four accelerators
 * are otherwise invisible. Modifiers follow the platform (⌘/⌥ on macOS,
 * Ctrl/Alt elsewhere).
 */
function RewriteShortcutsDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { t } = useI18n();
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";
  const alt = isMacPlatform() ? "⌥" : "Alt+";
  const rows = [
    { keys: `${mod}S`, label: t("rulesPage.rewrite.shortcuts.save") },
    { keys: `${mod}D`, label: t("rulesPage.rewrite.shortcuts.duplicate") },
    { keys: `${alt}↑ / ${alt}↓`, label: t("rulesPage.rewrite.shortcuts.reorder") },
    { keys: "↑ / ↓", label: t("rulesPage.rewrite.shortcuts.listNavigation") },
  ];

  return (
    <Dialog fullWidth maxWidth="xs" open={open} onClose={onClose}>
      <DialogTitle>{t("rulesPage.rewrite.shortcuts.title")}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List dense disablePadding>
          {rows.map((row) => (
            <Stack
              key={row.label}
              direction="row"
              spacing={2}
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                px: 2,
                py: 1,
                "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
              }}
            >
              <Typography variant="body2">{row.label}</Typography>
              <Typography
                component="kbd"
                variant="caption"
                sx={{
                  bgcolor: (theme) =>
                    alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  border: 1,
                  borderColor: "divider",
                  borderRadius: "6px",
                  fontFamily: fontFamilies.mono,
                  fontSize: 11,
                  px: 0.75,
                  py: 0.25,
                  whiteSpace: "nowrap",
                }}
              >
                {row.keys}
              </Typography>
            </Stack>
          ))}
        </List>
      </DialogContent>
    </Dialog>
  );
}

function RewriteRuleTester({
  draft,
  invalidCombination,
  onChange,
  onOpenSessionPicker,
  testInput,
  testResult,
}: {
  draft: RewriteRule;
  /** Continuous invalid-combination message; shown as the verdict detail when blocked. */
  invalidCombination: string | undefined;
  onChange: (input: RuleTestInput) => void;
  onOpenSessionPicker: () => void;
  testInput: RuleTestInput;
  testResult: RuleTestVerdict;
}) {
  const { t } = useI18n();
  const methodLabel = t("rulesPage.rewrite.tester.method");
  const stageLabel = t("rulesPage.rewrite.tester.stage");
  const verdictSeverity = testResult.blocked
    ? "warning"
    : testResult.ok
      ? "success"
      : testResult.disabled
        ? "warning"
        : "info";

  return (
    <RuleSection>
      <FieldGroup title={t("rulesPage.rewrite.tester.sectionTitle")}>
        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            alignItems: "center",
          }}
        >
          {testResult.blocked ? (
            <WarningAmberRoundedIcon color="warning" fontSize="small" />
          ) : testResult.ok ? (
            <CheckCircleRoundedIcon color="success" fontSize="small" />
          ) : testResult.disabled ? (
            <DoNotDisturbOnRoundedIcon color="warning" fontSize="small" />
          ) : (
            <CancelRoundedIcon sx={{ color: "info.main" }} fontSize="small" />
          )}
          <Typography variant="body2" sx={{ fontWeight: 700, flex: 1 }}>
            {t("rulesPage.rewrite.tester.title")}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={onOpenSessionPicker}
            sx={{ flexShrink: 0 }}
          >
            {t("rulesPage.rewrite.tester.pickFromSessions")}
          </Button>
        </Stack>
        <TextField
          label={t("rulesPage.rewrite.tester.sampleUrl")}
          onChange={(e) => onChange({ ...testInput, url: e.target.value })}
          size="small"
          value={testInput.url}
        />
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <FormControl size="small" fullWidth>
            <InputLabel>{methodLabel}</InputLabel>
            <Select
              label={methodLabel}
              value={testInput.method}
              onChange={(e) => onChange({ ...testInput, method: e.target.value })}
            >
              {HTTP_METHODS.map((method) => (
                <MenuItem key={method} value={method}>
                  {method}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>{stageLabel}</InputLabel>
            <Select
              label={stageLabel}
              value={testInput.stage}
              onChange={(e) =>
                onChange({ ...testInput, stage: e.target.value as RuleMatch["stage"] })
              }
            >
              <MenuItem value="either">{t("rulesPage.rewrite.tester.stageEither")}</MenuItem>
              <MenuItem value="request">{t("rulesPage.rewrite.tester.stageRequest")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.rewrite.tester.stageResponse")}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <Alert severity={verdictSeverity} variant="outlined" sx={{ py: 0.25 }}>
          {testResult.reason}
        </Alert>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {testResult.blocked
            ? invalidCombination
            : testResult.ok
              ? describeRewriteAction(draft, t)
              : t("rulesPage.rewrite.tester.waiting", {
                  pattern: draft.match.urlPattern || "(url pattern)",
                })}
        </Typography>
      </FieldGroup>
    </RuleSection>
  );
}

/**
 * Tester session picker: lists recent captured sessions from the shared
 * sessions query layer and lets one fill the tester inputs. Rendered
 * conditionally by the panel so the query only mounts while open.
 */
function SessionPickerDialog({
  onClose,
  onPick,
  open,
}: {
  onClose: () => void;
  onPick: (session: SessionSummary) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const { data: sessions = [], isError, isLoading } = useSessions();
  const [query, setQuery] = useState("");
  const recent = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? sessions.filter((s) => `${s.method} ${s.host} ${s.path} ${s.url}`.toLowerCase().includes(q))
      : sessions;
    return matched.slice(0, 50);
  }, [sessions, query]);

  return (
    <Dialog fullWidth maxWidth="sm" open={open} onClose={onClose}>
      <DialogTitle>{t("rulesPage.rewrite.tester.sessionPickerTitle")}</DialogTitle>
      <DialogContent dividers sx={{ minHeight: 200, p: 0 }}>
        {isLoading ? (
          <Stack spacing={1} sx={{ alignItems: "center", py: 6 }}>
            <CircularProgress
              size={28}
              aria-label={t("rulesPage.rewrite.tester.sessionPickerLoading")}
            />
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("rulesPage.rewrite.tester.sessionPickerLoading")}
            </Typography>
          </Stack>
        ) : isError ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {t("common.errors.queryFailed")}
          </Alert>
        ) : sessions.length === 0 ? (
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", px: 3, py: 6, textAlign: "center" }}
          >
            {t("rulesPage.rewrite.tester.sessionPickerEmpty")}
          </Typography>
        ) : (
          <>
            <Box sx={{ borderBottom: 1, borderColor: "divider", p: 1.5 }}>
              <OutlinedInput
                autoFocus
                fullWidth
                size="small"
                placeholder={t("rulesPage.rewrite.tester.sessionPickerSearchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                startAdornment={
                  <InputAdornment position="start">
                    <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 18 }} />
                  </InputAdornment>
                }
                sx={{ bgcolor: "background.paper", fontSize: 13, height: 36 }}
              />
            </Box>
            {recent.length === 0 ? (
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", px: 3, py: 6, textAlign: "center" }}
              >
                {t("rulesPage.rewrite.tester.sessionPickerNoMatch")}
              </Typography>
            ) : (
              <List dense disablePadding>
                {recent.map((session) => (
                  <ListItemButton
                    key={session.id}
                    onClick={() => onPick(session)}
                    sx={{
                      gap: 1,
                      px: 2,
                      py: 0.75,
                      "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
                    }}
                  >
                    <Chip
                      size="small"
                      label={session.method.toUpperCase()}
                      variant="outlined"
                      sx={{
                        fontFamily: fontFamilies.mono,
                        fontSize: 10,
                        height: 20,
                        flexShrink: 0,
                      }}
                    />
                    <ListItemText
                      primary={`${session.host}${session.path === "/" ? "" : session.path}`}
                      secondary={session.url}
                      slotProps={{
                        primary: { noWrap: true, sx: { fontSize: 13, fontWeight: 600 } },
                        secondary: {
                          noWrap: true,
                          sx: { fontFamily: fontFamilies.mono, fontSize: 11 },
                        },
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RewriteActionFields(props: {
  errors: RuleFieldErrors;
  onChange: (rule: RewriteRule) => void;
  rule: RewriteRule;
  validationAttempted: boolean;
}) {
  const { t } = useI18n();
  const { errors, onChange, rule, validationAttempted } = props;

  function updateAction(index: number, action: RewriteAction) {
    const actions = rule.actions.map((candidate, candidateIndex) =>
      candidateIndex === index ? action : candidate,
    );
    onChange({ ...rule, actions, rewriteType: actions[0]?.rewriteType ?? "header" });
  }

  function removeAction(index: number) {
    const actions = rule.actions.filter((_, candidateIndex) => candidateIndex !== index);
    onChange({ ...rule, actions, rewriteType: actions[0]?.rewriteType ?? "header" });
  }

  function moveAction(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rule.actions.length) return;
    const actions = [...rule.actions];
    const [moving] = actions.splice(index, 1);
    if (!moving) return;
    actions.splice(target, 0, moving);
    onChange({ ...rule, actions });
  }

  function addAction() {
    onChange({
      ...rule,
      actions: [...rule.actions, createEmptyRewriteAction("header")],
    });
  }

  return (
    <Stack spacing={1.25}>
      {rule.actions.length === 0 && (
        <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
          {t("rulesPage.rewrite.actionsRequired")}
        </Alert>
      )}
      {rule.actions.map((action, index) => (
        <Paper
          key={index}
          elevation={0}
          sx={(theme) => ({
            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.06 : 0.03),
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            p: 1.25,
          })}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.25 }}>
            <Typography variant="body2" sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>
              {t("rulesPage.rewrite.actionLabel", { index: index + 1 })}
            </Typography>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <Select
                value={action.rewriteType}
                SelectDisplayProps={{ "aria-label": t("rulesPage.rewrite.actionType") }}
                onChange={(e) =>
                  updateAction(index, createEmptyRewriteAction(e.target.value as RewriteRuleType))
                }
              >
                {(["header", "query", "body", "redirect"] as const).map((type) => (
                  <MenuItem key={type} value={type}>
                    {getRewriteTypeLabel(type, t)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ flex: 1 }} />
            <Tooltip title={t("common.actions.moveUp")}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t("common.actions.moveUp")}
                  disabled={index === 0}
                  onClick={() => moveAction(index, -1)}
                >
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("common.actions.moveDown")}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t("common.actions.moveDown")}
                  disabled={index === rule.actions.length - 1}
                  onClick={() => moveAction(index, 1)}
                >
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("common.actions.remove")}>
              <span>
                <IconButton
                  size="small"
                  color="error"
                  aria-label={t("common.actions.remove")}
                  disabled={rule.actions.length === 1}
                  onClick={() => removeAction(index)}
                >
                  <DeleteRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <RewriteActionFieldsInner
            action={action}
            errors={errors}
            index={index}
            onChange={(next) => updateAction(index, next)}
            validationAttempted={validationAttempted}
          />
        </Paper>
      ))}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddRoundedIcon />}
        onClick={addAction}
        sx={{ alignSelf: "flex-start" }}
      >
        {t("rulesPage.rewrite.addAction")}
      </Button>
    </Stack>
  );
}

function RewriteActionFieldsInner(props: {
  action: RewriteAction;
  errors: RuleFieldErrors;
  index: number;
  onChange: (action: RewriteAction) => void;
  validationAttempted: boolean;
}) {
  const { t } = useI18n();
  const { action, errors, index, onChange, validationAttempted } = props;
  const required = (label: string) => formatRuleFieldLabel(label, "required", t);
  const optional = (label: string) => formatRuleFieldLabel(label, "optional", t);
  const key = (field: string) => `actions.${index}.payload.${field}`;

  if (action.rewriteType === "header") {
    const targetLabel = required(t("rulesPage.rewrite.headerTarget"));
    const operationLabel = required(t("rulesPage.rewrite.operation"));
    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{targetLabel}</InputLabel>
            <Select
              label={targetLabel}
              value={action.payload.target}
              onChange={(e) =>
                onChange({
                  ...action,
                  payload: {
                    ...action.payload,
                    target: e.target.value as "request" | "response",
                  },
                })
              }
            >
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>{operationLabel}</InputLabel>
            <Select
              label={operationLabel}
              value={action.payload.operation}
              onChange={(e) =>
                onChange({
                  ...action,
                  payload: {
                    ...action.payload,
                    operation: e.target.value as "set" | "remove",
                  },
                })
              }
            >
              <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
              <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <TextField
          size="small"
          label={required(t("rulesPage.rewrite.headerName"))}
          value={action.payload.headerName}
          onChange={(e) =>
            onChange({
              ...action,
              payload: { ...action.payload, headerName: e.target.value },
            })
          }
          {...ruleFieldProps(errors, validationAttempted, key("headerName"))}
          placeholder={t("rulesPage.rewrite.headerNameExample")}
        />
        {action.payload.operation === "set" && (
          <TextField
            size="small"
            label={required(t("rulesPage.rewrite.headerValue"))}
            value={action.payload.value ?? ""}
            onChange={(e) =>
              onChange({ ...action, payload: { ...action.payload, value: e.target.value } })
            }
            {...ruleFieldProps(errors, validationAttempted, key("value"))}
            placeholder={t("rulesPage.rewrite.headerValueExample")}
          />
        )}
      </Stack>
    );
  }

  if (action.rewriteType === "query") {
    const operationLabel = required(t("rulesPage.rewrite.operation"));
    return (
      <Stack spacing={1.5}>
        <FormControl size="small" fullWidth>
          <InputLabel>{operationLabel}</InputLabel>
          <Select
            label={operationLabel}
            value={action.payload.operation}
            onChange={(e) =>
              onChange({
                ...action,
                payload: {
                  ...action.payload,
                  operation: e.target.value as "set" | "remove",
                },
              })
            }
          >
            <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
            <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          label={required(t("rulesPage.rewrite.queryName"))}
          value={action.payload.paramName}
          onChange={(e) =>
            onChange({
              ...action,
              payload: { ...action.payload, paramName: e.target.value },
            })
          }
          {...ruleFieldProps(errors, validationAttempted, key("paramName"))}
          placeholder={t("rulesPage.rewrite.queryNameExample")}
        />
        {action.payload.operation === "set" && (
          <TextField
            size="small"
            label={required(t("rulesPage.rewrite.queryValue"))}
            value={action.payload.value ?? ""}
            onChange={(e) =>
              onChange({ ...action, payload: { ...action.payload, value: e.target.value } })
            }
            {...ruleFieldProps(errors, validationAttempted, key("value"))}
            placeholder={t("rulesPage.rewrite.queryValueExample")}
          />
        )}
      </Stack>
    );
  }

  if (action.rewriteType === "body") {
    const targetLabel = required(t("rulesPage.rewrite.bodyTarget"));
    const mode = action.payload.mode ?? "replace";

    return (
      <Stack spacing={1.5}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>{targetLabel}</InputLabel>
            <Select
              label={targetLabel}
              value={action.payload.target}
              onChange={(e) =>
                onChange({
                  ...action,
                  payload: {
                    ...action.payload,
                    target: e.target.value as "request" | "response",
                  },
                })
              }
            >
              <MenuItem value="request">{t("rulesPage.stages.request")}</MenuItem>
              <MenuItem value="response">{t("rulesPage.stages.response")}</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label={optional(t("rulesPage.rewrite.contentType"))}
            value={action.payload.contentType}
            onChange={(e) =>
              onChange({
                ...action,
                payload: { ...action.payload, contentType: e.target.value },
              })
            }
          />
        </Stack>
        <ToggleButtonGroup
          exclusive
          fullWidth
          onChange={(_, value: "replace" | "fields" | null) => {
            if (!value) return;
            onChange({
              ...action,
              payload: {
                ...action.payload,
                fields: action.payload.fields?.length
                  ? action.payload.fields
                  : [{ operation: "set", path: "", value: "", valueType: "string" }],
                mode: value,
              },
            });
          }}
          size="small"
          value={mode}
        >
          <ToggleButton value="replace">{t("rulesPage.rewrite.bodyModes.replace")}</ToggleButton>
          <ToggleButton value="fields">{t("rulesPage.rewrite.bodyModes.fields")}</ToggleButton>
        </ToggleButtonGroup>
        {mode === "replace" ? (
          <TextField
            size="small"
            multiline
            minRows={6}
            label={required(t("rulesPage.rewrite.bodyText"))}
            value={action.payload.text ?? ""}
            onChange={(e) =>
              onChange({ ...action, payload: { ...action.payload, text: e.target.value } })
            }
            {...ruleFieldProps(errors, validationAttempted, key("text"))}
            sx={{ "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 } }}
          />
        ) : (
          <BodyFieldsEditor
            errors={errors}
            fields={action.payload.fields ?? []}
            keyPrefix={key("fields")}
            onChange={(fields) => onChange({ ...action, payload: { ...action.payload, fields } })}
            validationAttempted={validationAttempted}
          />
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={required(t("rulesPage.rewrite.redirectTarget"))}
        value={action.payload.targetUrl}
        onChange={(e) =>
          onChange({
            ...action,
            payload: { ...action.payload, targetUrl: e.target.value },
          })
        }
        {...ruleFieldProps(errors, validationAttempted, key("targetUrl"))}
        placeholder={t("rulesPage.rewrite.redirectTargetExample")}
      />
      <Stack direction="row" spacing={2}>
        <InlineSwitch
          label={t("rulesPage.rewrite.preservePath")}
          checked={action.payload.preservePath}
          onChange={(v) => onChange({ ...action, payload: { ...action.payload, preservePath: v } })}
        />
        <InlineSwitch
          label={t("rulesPage.rewrite.preserveQuery")}
          checked={action.payload.preserveQuery}
          onChange={(v) =>
            onChange({ ...action, payload: { ...action.payload, preserveQuery: v } })
          }
        />
      </Stack>
    </Stack>
  );
}

// Each body-rewrite field row previously used `key={index}`, so deleting a
// middle row re-indexed the list and React reused DOM nodes by position — the
// wrong row's inputs then bound to the shifted fields (focus jumps, values
// shuffle, "delete the wrong row"). This editor layers a LOCAL-only id on top
// of the RewriteBodyFieldEdit[] for rendering, and strips it before emitting,
// so the shared RewriteBodyFieldEdit contract and save_rewrite_rule payload
// are unchanged.
type BodyFieldRow = RewriteBodyFieldEdit & { id: string };

function sameBodyFields(a: RewriteBodyFieldEdit[], b: RewriteBodyFieldEdit[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((field, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      field.operation === other.operation &&
      field.path === other.path &&
      field.value === other.value &&
      field.valueType === other.valueType
    );
  });
}

function toBodyFieldEdits(rows: BodyFieldRow[]): RewriteBodyFieldEdit[] {
  return rows.map((row) => ({
    operation: row.operation,
    path: row.path,
    ...(row.value === undefined ? {} : { value: row.value }),
    ...(row.valueType === undefined ? {} : { valueType: row.valueType }),
  }));
}

function BodyFieldsEditor({
  errors,
  fields,
  keyPrefix = "payload.fields",
  onChange,
  validationAttempted,
}: {
  errors: RuleFieldErrors;
  fields: RewriteBodyFieldEdit[];
  /** Error-key prefix, e.g. `actions.0.payload.fields` for multi-action rules. */
  keyPrefix?: string;
  onChange: (fields: RewriteBodyFieldEdit[]) => void;
  validationAttempted: boolean;
}) {
  const { t } = useI18n();
  const required = (label: string) => formatRuleFieldLabel(label, "required", t);

  // Local rows mirror `fields` but carry a stable per-row id. The id survives
  // this editor's own edits; it is regenerated only on an external reset.
  const [rows, setRows] = useState<BodyFieldRow[]>(() =>
    fields.map((field) => ({ ...field, id: crypto.randomUUID() })),
  );
  const lastEmittedRef = useRef<RewriteBodyFieldEdit[]>(fields);

  useEffect(() => {
    if (sameBodyFields(lastEmittedRef.current, fields)) return;
    lastEmittedRef.current = fields;
    setRows(fields.map((field) => ({ ...field, id: crypto.randomUUID() })));
  }, [fields]);

  function emit(next: BodyFieldRow[]) {
    // Strip the local id at the boundary so callers receive RewriteBodyFieldEdit[].
    const stripped = toBodyFieldEdits(next);
    lastEmittedRef.current = stripped;
    setRows(next);
    onChange(stripped);
  }

  const pathLabel = required(t("rulesPage.rewrite.bodyFieldPath"));
  const operationLabel = required(t("rulesPage.rewrite.operation"));
  const valueTypeLabel = required(t("rulesPage.rewrite.bodyValueType"));
  const valueLabel = required(t("rulesPage.rewrite.bodyFieldValue"));

  return (
    <Stack spacing={1}>
      {rows.length === 0 ? (
        <Alert severity="info" variant="outlined" sx={{ py: 0.25 }}>
          {t("rulesPage.rewrite.bodyFieldsEmpty")}
        </Alert>
      ) : (
        rows.map((field, index) => (
          <Box
            key={field.id}
            sx={{
              display: "grid",
              gap: 1,
              gridTemplateColumns: {
                xs: "1fr",
                md: "minmax(160px, 1.1fr) 120px 120px minmax(180px, 1fr) auto",
              },
            }}
          >
            <TextField
              size="small"
              label={pathLabel}
              {...ruleFieldProps(errors, validationAttempted, `${keyPrefix}.${index}.path`)}
              placeholder={t("rulesPage.rewrite.bodyFieldPathExample")}
              value={field.path}
              onChange={(e) =>
                emit(
                  rows.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, path: e.target.value } : row,
                  ),
                )
              }
              sx={{
                "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 },
              }}
            />
            <FormControl size="small">
              <InputLabel>{operationLabel}</InputLabel>
              <Select
                label={operationLabel}
                value={field.operation}
                onChange={(e) =>
                  emit(
                    rows.map((row, rowIndex) =>
                      rowIndex === index
                        ? {
                            ...row,
                            operation: e.target.value as RewriteBodyFieldEdit["operation"],
                          }
                        : row,
                    ),
                  )
                }
              >
                <MenuItem value="set">{t("rulesPage.rewrite.operations.set")}</MenuItem>
                <MenuItem value="remove">{t("rulesPage.rewrite.operations.remove")}</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" disabled={field.operation === "remove"}>
              <InputLabel>{valueTypeLabel}</InputLabel>
              <Select
                label={valueTypeLabel}
                value={field.valueType ?? "string"}
                onChange={(e) =>
                  emit(
                    rows.map((row, rowIndex) =>
                      rowIndex === index
                        ? {
                            ...row,
                            valueType: e.target.value as NonNullable<
                              RewriteBodyFieldEdit["valueType"]
                            >,
                          }
                        : row,
                    ),
                  )
                }
              >
                <MenuItem value="string">{t("rulesPage.rewrite.bodyValueTypes.string")}</MenuItem>
                <MenuItem value="number">{t("rulesPage.rewrite.bodyValueTypes.number")}</MenuItem>
                <MenuItem value="boolean">{t("rulesPage.rewrite.bodyValueTypes.boolean")}</MenuItem>
                <MenuItem value="null">{t("rulesPage.rewrite.bodyValueTypes.null")}</MenuItem>
                <MenuItem value="json">{t("rulesPage.rewrite.bodyValueTypes.json")}</MenuItem>
              </Select>
            </FormControl>
            <TextField
              disabled={field.operation === "remove" || field.valueType === "null"}
              size="small"
              label={valueLabel}
              {...ruleFieldProps(errors, validationAttempted, `${keyPrefix}.${index}.value`)}
              value={field.value ?? ""}
              onChange={(e) =>
                emit(
                  rows.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, value: e.target.value } : row,
                  ),
                )
              }
              sx={{
                "& .MuiInputBase-input": { fontFamily: fontFamilies.mono, fontSize: 13 },
              }}
            />
            <Button
              color="error"
              onClick={() => emit(rows.filter((_, rowIndex) => rowIndex !== index))}
              size="small"
              startIcon={<DeleteRoundedIcon />}
              variant="outlined"
              sx={{ minWidth: { xs: "100%", md: 44 }, px: { xs: 1.5, md: 1 } }}
            >
              {t("common.actions.remove")}
            </Button>
          </Box>
        ))
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddRoundedIcon />}
        onClick={() =>
          emit([
            ...rows,
            { id: crypto.randomUUID(), operation: "set", path: "", value: "", valueType: "string" },
          ])
        }
        sx={{ alignSelf: "flex-start" }}
      >
        {t("rulesPage.rewrite.addBodyField")}
      </Button>
    </Stack>
  );
}
