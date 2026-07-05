import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  useDeleteThrottleRule,
  useSaveThrottleProfile,
  useSaveThrottleRule,
  useSetActiveThrottleProfile,
  useThrottleProfiles,
  useThrottleRules,
  useThrottleRuntimeStats,
} from "@/features/throttling/use-throttle-profiles";
import { useI18n, type TranslationKey, type TranslationParams } from "@/i18n";

// --- Constants ---

export const DEFAULT_WORKSPACE_ID = "default";
export const TEMP_ENABLE_MS = 15 * 60 * 1000;

export type ThrottleSeed = {
  host?: string;
  method?: string;
  path?: string;
  url?: string;
};

// --- Factory helpers ---

export function createEmptyThrottleProfile(): ThrottleProfile {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    latencyMs: 120,
    uploadKbps: 1000,
    downloadKbps: 4000,
    packetLossRatio: 0,
    enabled: false,
    preset: false,
    note: "",
  };
}

export function createRuleDraft(profileId: string, seed?: ThrottleSeed): ThrottleRule {
  const urlPattern = seed?.url
    ? seed.url
    : seed?.host
      ? `*://${seed.host}${seed.path && seed.path !== "/" ? seed.path : "/*"}`
      : "*";

  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: seed?.host ? `${seed.method ?? "Any"} ${seed.host}` : "Targeted rule",
    enabled: true,
    priority: 100,
    profileId,
    urlPattern,
    methods: seed?.method ? [seed.method] : [],
    stage: "both",
    note: "",
  };
}

// --- Validation ---

export function getThrottleValidationErrors(
  profile: ThrottleProfile,
  t: (key: TranslationKey, params?: TranslationParams) => string,
): string[] {
  const errors: string[] = [];
  if (!profile.name.trim()) errors.push(t("throttlingPage.validation.nameRequired"));
  if (profile.latencyMs < 0) errors.push(t("throttlingPage.validation.latencyInvalid"));
  if (profile.uploadKbps <= 0 || profile.downloadKbps <= 0)
    errors.push(t("throttlingPage.validation.bandwidthInvalid"));
  if (profile.packetLossRatio < 0 || profile.packetLossRatio > 100)
    errors.push(t("throttlingPage.validation.lossInvalid"));
  return errors;
}

export function getRuleValidationErrors(
  rule: ThrottleRule,
  t: (key: TranslationKey, params?: TranslationParams) => string,
): string[] {
  const errors: string[] = [];
  if (!rule.name.trim()) errors.push(t("throttlingPage.validation.ruleNameRequired"));
  if (!rule.profileId) errors.push(t("throttlingPage.validation.ruleProfileRequired"));
  if (!rule.urlPattern.trim()) errors.push(t("throttlingPage.validation.ruleUrlPatternRequired"));
  return errors;
}

// --- Format helpers ---

export function formatDelay(delayMs: number): string {
  if (delayMs < 1000) return `${delayMs} ms`;
  return `${(delayMs / 1000).toFixed(1)} s`;
}

// --- Hook ---

export function useThrottleEditor() {
  const { t } = useI18n();
  const location = useLocation();
  const seed = (location.state as { throttleSeed?: ThrottleSeed } | null)?.throttleSeed;

  const { data: profiles = [], isError: isProfilesError } = useThrottleProfiles();
  const { data: rules = [], isError: isRulesError } = useThrottleRules();
  const { data: stats } = useThrottleRuntimeStats();
  const saveProfileMutation = useSaveThrottleProfile();
  const saveRuleMutation = useSaveThrottleRule();
  const deleteRuleMutation = useDeleteThrottleRule();
  const setActiveMutation = useSetActiveThrottleProfile();

  const [mode, setMode] = useState<"profiles" | "rules">("profiles");
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [profileDraft, setProfileDraft] = useState<ThrottleProfile>(createEmptyThrottleProfile());
  const [ruleDraft, setRuleDraft] = useState<ThrottleRule | null>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [temporaryUntil, setTemporaryUntil] = useState<number | null>(null);
  const [temporaryNow, setTemporaryNow] = useState(() => Date.now());
  const seedAppliedRef = useRef(false);
  // Track the last id we synced a draft from, so a TanStack Query refetch
  // (new rules[]/profiles[] array identity → new selectedRule/selectedProfile
  // object identity) does NOT re-run the draft-sync and clobber an in-flight
  // edit. The sync effect now fires only when the selected id actually
  // changes (H1).
  const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);
  const lastSyncedProfileIdRef = useRef<string | undefined>(undefined);
  // M23: the profile id that the current temporary-enable window targets.
  // The timeout callback only deactivates the profile if it is STILL the one
  // the user temporarily enabled — if the user manually switched to a
  // different profile in the meantime, the timer must NOT silently disable
  // that newly-chosen profile.
  const temporaryProfileIdRef = useRef<string | undefined>(undefined);
  // M23: mirror the current active profile id into a ref so the
  // temporary-enable timeout callback (which must NOT be re-created on every
  // activeProfile change, or it would reset its own deadline) can read the
  // latest active profile id at fire time without a stale closure.
  const activeProfileIdRef = useRef<string | undefined>(undefined);

  // Computed
  const activeProfile = useMemo(() => profiles.find((profile) => profile.enabled), [profiles]);
  // M23: keep activeProfileIdRef in sync with the latest active profile id.
  useEffect(() => {
    activeProfileIdRef.current = activeProfile?.id;
  }, [activeProfile]);
  const presetProfiles = useMemo(() => profiles.filter((profile) => profile.preset), [profiles]);
  const customProfiles = useMemo(() => profiles.filter((profile) => !profile.preset), [profiles]);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  );
  const selectedRule = useMemo(
    () => rules.find((rule) => rule.id === selectedRuleId),
    [rules, selectedRuleId],
  );
  const activeRuleCount = useMemo(() => rules.filter((rule) => rule.enabled).length, [rules]);
  // Memoize the derived error/label values so child components receiving them
  // aren't re-rendered on every keystroke (the inputs update profileDraft/ruleDraft
  // frequently). Previously these rebuilt new arrays/strings each render (L15).
  const profileErrors = useMemo(
    () => getThrottleValidationErrors(profileDraft, t),
    [profileDraft, t],
  );
  const ruleErrors = useMemo(
    () => (ruleDraft ? getRuleValidationErrors(ruleDraft, t) : []),
    [ruleDraft, t],
  );
  const activeStatusLabel = useMemo(
    () =>
      activeProfile
        ? t("throttlingPage.activeSummary", { name: activeProfile.name })
        : t("throttlingPage.inactiveSummary"),
    [activeProfile, t],
  );
  const temporaryRemaining = temporaryUntil ? Math.max(0, temporaryUntil - temporaryNow) : 0;

  // Effects
  useEffect(() => {
    if (seed && profiles.length > 0 && !seedAppliedRef.current) {
      seedAppliedRef.current = true;
      const baseProfile = activeProfile ?? profiles[0];
      if (!baseProfile) return;
      const draft = createRuleDraft(baseProfile.id, seed);
      setMode("rules");
      setSelectedRuleId(draft.id);
      lastSyncedRuleIdRef.current = draft.id;
      setRuleDraft(draft);
    }
  }, [activeProfile, profiles, seed]);

  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) return;
    const next = activeProfile ?? presetProfiles[0] ?? customProfiles[0];
    if (!next) return;
    setSelectedProfileId(next.id);
    setProfileDraft(next);
  }, [activeProfile, customProfiles, presetProfiles, profiles, selectedProfileId]);

  useEffect(() => {
    // Only sync the profile draft when the selection actually changes —
    // NOT on every profiles[] refetch (new selectedProfile object identity).
    // This protects in-flight profile edits from being clobbered (H1).
    if (mode !== "profiles") return;
    if (lastSyncedProfileIdRef.current === selectedProfileId) return;
    lastSyncedProfileIdRef.current = selectedProfileId;
    if (selectedProfile) {
      setProfileDraft(selectedProfile);
      setValidationAttempted(false);
    }
  }, [mode, selectedProfileId, selectedProfile]);

  useEffect(() => {
    // Only sync from the server value when the selection actually changes —
    // NOT on every rules[] refetch (new selectedRule object identity). This
    // protects in-flight edits from being clobbered (H1).
    if (lastSyncedRuleIdRef.current === selectedRuleId) return;
    lastSyncedRuleIdRef.current = selectedRuleId;
    if (selectedRule) {
      setRuleDraft(selectedRule);
    } else if (rules[0]) {
      setSelectedRuleId(rules[0].id);
    }
  }, [selectedRuleId, selectedRule, rules]);

  useEffect(() => {
    if (!temporaryUntil) return undefined;
    const temporaryProfileId = temporaryProfileIdRef.current;
    const timeout = window.setTimeout(
      () => {
        // M23: only deactivate if the currently-active profile is STILL the
        // one the user temporarily enabled. If the user manually activated a
        // different profile in the meantime (setActiveMutation.mutate(other)),
        // the timer must not silently disable their new choice.
        if (
          temporaryProfileId !== undefined &&
          activeProfileIdRef.current !== temporaryProfileId
        ) {
          setTemporaryUntil(null);
          return;
        }
        setActiveMutation.mutate(undefined);
        setTemporaryUntil(null);
      },
      Math.max(0, temporaryUntil - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [setActiveMutation, temporaryUntil]);

  useEffect(() => {
    if (!temporaryUntil) return undefined;
    setTemporaryNow(Date.now());
    const interval = window.setInterval(() => setTemporaryNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [temporaryUntil]);

  // Actions
  function selectProfile(profile: ThrottleProfile) {
    setMode("profiles");
    setSelectedProfileId(profile.id);
    lastSyncedProfileIdRef.current = profile.id;
    setProfileDraft(profile);
    setValidationAttempted(false);
  }

  function selectRule(rule: ThrottleRule) {
    setMode("rules");
    setSelectedRuleId(rule.id);
    // Pre-mark as synced so the id-based effect doesn't overwrite the draft we
    // are about to set with the (possibly stale) server value.
    lastSyncedRuleIdRef.current = rule.id;
    setRuleDraft(rule);
    setValidationAttempted(false);
  }

  function duplicateRule(rule: ThrottleRule) {
    const copy: ThrottleRule = {
      ...rule,
      id: crypto.randomUUID(),
      name: `${rule.name} copy`,
    };
    // Move selection AND draft together so the copy survives — otherwise the
    // sync effect would immediately revert the copy back to the original
    // (H2).
    setMode("rules");
    setSelectedRuleId(copy.id);
    lastSyncedRuleIdRef.current = copy.id;
    setRuleDraft(copy);
    setValidationAttempted(false);
  }

  function handleNewProfile() {
    const draft = createEmptyThrottleProfile();
    setMode("profiles");
    setSelectedProfileId(draft.id);
    // Pre-mark as synced so the id-based profile-sync effect doesn't overwrite
    // the fresh empty draft we are about to set. Mirrors handleNewRule (H1/H2).
    lastSyncedProfileIdRef.current = draft.id;
    setProfileDraft(draft);
    setValidationAttempted(false);
  }

  function handleSaveProfile(enableAfterSave = false) {
    if (isProfilesError) return;
    setValidationAttempted(true);
    if (profileErrors.length > 0) return;
    saveProfileMutation.mutate(
      { ...profileDraft, enabled: enableAfterSave ? true : profileDraft.enabled },
      {
        onSuccess: (saved) => {
          setSelectedProfileId(saved.id);
          setProfileDraft(saved);
          setValidationAttempted(false);
          if (enableAfterSave) setActiveMutation.mutate(saved.id);
        },
      },
    );
  }

  function handleTemporaryEnable() {
    if (isProfilesError) return;
    const target = selectedProfileId ?? activeProfile?.id ?? profiles[0]?.id;
    if (!target) return;
    // M23: record which profile this temporary-enable targets so the timeout
    // callback can verify the active profile is still this one before
    // disabling.
    temporaryProfileIdRef.current = target;
    setTemporaryUntil(Date.now() + TEMP_ENABLE_MS);
    setActiveMutation.mutate(target);
  }

  function handleNewRule() {
    if (isRulesError) return;
    const profileId = activeProfile?.id ?? selectedProfileId ?? profiles[0]?.id;
    if (!profileId) return;
    const draft = createRuleDraft(profileId);
    setMode("rules");
    setSelectedRuleId(draft.id);
    lastSyncedRuleIdRef.current = draft.id;
    setRuleDraft(draft);
    setValidationAttempted(false);
  }

  function handleSaveRule() {
    if (isRulesError) return;
    if (!ruleDraft) return;
    setValidationAttempted(true);
    if (ruleErrors.length > 0) return;
    saveRuleMutation.mutate(ruleDraft, {
      onSuccess: (saved) => {
        setSelectedRuleId(saved.id);
        lastSyncedRuleIdRef.current = saved.id;
        setRuleDraft(saved);
        setValidationAttempted(false);
      },
    });
  }

  function updateRuleDraft(patch: Partial<ThrottleRule>) {
    setRuleDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function handleDeleteRule(ruleId: string) {
    deleteRuleMutation.mutate(ruleId, {
      onSuccess: () => {
        setSelectedRuleId(undefined);
        lastSyncedRuleIdRef.current = undefined;
        setRuleDraft(null);
      },
    });
  }

  function handleDisableGlobal() {
    setTemporaryUntil(null);
    setActiveMutation.mutate(undefined);
  }

  return {
    // Data
    profiles,
    rules,
    stats,
    isProfilesError,
    isRulesError,

    // Computed
    activeProfile,
    presetProfiles,
    customProfiles,
    activeRuleCount,
    activeStatusLabel,
    temporaryRemaining,

    // Mode & selection
    mode,
    setMode,
    selectedProfileId,
    selectedRuleId,
    setSelectedRuleId,
    profileDraft,
    ruleDraft,

    // Validation
    validationAttempted,
    profileErrors,
    ruleErrors,

    // Mutations
    saveProfilePending: saveProfileMutation.isPending,
    setActivePending: setActiveMutation.isPending,
    saveRulePending: saveRuleMutation.isPending,

    // Temporary enable
    temporaryUntil,

    // Actions
    selectProfile,
    selectRule,
    duplicateRule,
    handleNewProfile,
    handleSaveProfile,
    handleTemporaryEnable,
    handleNewRule,
    handleSaveRule,
    updateRuleDraft,
    handleDeleteRule,
    handleDisableGlobal,
    setProfileDraft,
    setRuleDraft,

    // i18n
    t,
  };
}
