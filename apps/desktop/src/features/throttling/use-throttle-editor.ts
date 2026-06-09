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

  // Computed
  const activeProfile = useMemo(() => profiles.find((profile) => profile.enabled), [profiles]);
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
  const profileErrors = getThrottleValidationErrors(profileDraft, t);
  const ruleErrors = ruleDraft ? getRuleValidationErrors(ruleDraft, t) : [];
  const activeStatusLabel = activeProfile
    ? t("throttlingPage.activeSummary", { name: activeProfile.name })
    : t("throttlingPage.inactiveSummary");
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
    if (!selectedProfile) return;
    if (mode === "profiles") {
      setProfileDraft(selectedProfile);
      setValidationAttempted(false);
    }
  }, [mode, selectedProfile]);

  useEffect(() => {
    if (selectedRule) {
      setRuleDraft(selectedRule);
      return;
    }

    if (!ruleDraft && rules[0]) {
      setSelectedRuleId(rules[0].id);
      setRuleDraft(rules[0]);
    }
  }, [ruleDraft, rules, selectedRule]);

  useEffect(() => {
    if (!temporaryUntil) return undefined;
    const timeout = window.setTimeout(
      () => {
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
    setProfileDraft(profile);
    setValidationAttempted(false);
  }

  function handleNewProfile() {
    const draft = createEmptyThrottleProfile();
    setMode("profiles");
    setSelectedProfileId(draft.id);
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
