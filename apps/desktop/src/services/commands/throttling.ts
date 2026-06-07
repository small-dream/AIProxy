import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  DEFAULT_WORKSPACE_ID,
  parseThrottleProfiles,
  parseThrottleRules,
  parseThrottleRuntimeStats,
  parseThrottleSessionTrace,
  type ThrottleProfile,
  type ThrottleRule,
  type ThrottleRuntimeStats,
  type ThrottleSessionTrace,
} from "@aiproxy/shared-types";

import { getImportedSessionDetail } from "@/features/sessions/imported-sessions.store";

import { isTauriRuntime, reportCommandFailure, shouldFallbackToLocalStore } from "./runtime";

const THROTTLE_PROFILES_STORAGE_KEY = "aiproxy.throttle.profiles";
const THROTTLE_RULES_STORAGE_KEY = "aiproxy.throttle.rules";

function readStoredRules<T>(storageKey: string, parser: (value: unknown) => T[]): T[] {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return [];
  }

  const rawValue = window.localStorage.getItem(storageKey);

  if (!rawValue) {
    return [];
  }

  try {
    return parser(JSON.parse(rawValue));
  } catch (error) {
    reportCommandFailure(`read_local_store:${storageKey}`, error);
    return [];
  }
}

function writeStoredRules(storageKey: string, value: unknown) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(value));
}

function upsertStoredEntity<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);

  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

function createDefaultThrottleProfiles(workspaceId: string): ThrottleProfile[] {
  return [
    {
      id: "preset-fast-4g",
      workspaceId,
      name: "Fast 4G",
      latencyMs: 80,
      uploadKbps: 1200,
      downloadKbps: 9000,
      packetLossRatio: 0.2,
      enabled: false,
      preset: true,
      note: "Balanced mobile profile for everyday app verification.",
    },
    {
      id: "preset-slow-3g",
      workspaceId,
      name: "Slow 3G",
      latencyMs: 300,
      uploadKbps: 320,
      downloadKbps: 768,
      packetLossRatio: 1.2,
      enabled: false,
      preset: true,
      note: "Useful for sign-in, skeleton loading, and retry validation.",
    },
    {
      id: "preset-lossy-wifi",
      workspaceId,
      name: "Lossy Wi-Fi",
      latencyMs: 45,
      uploadKbps: 6400,
      downloadKbps: 24000,
      packetLossRatio: 3.5,
      enabled: false,
      preset: true,
      note: "Good for reconnect logic and flaky LAN simulations.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Workspace commands
// ---------------------------------------------------------------------------

export async function listThrottleProfiles(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ThrottleProfile[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_throttle_profiles", {
        input: { workspaceId },
      });

      return parseThrottleProfiles(payload);
    } catch (error) {
      reportCommandFailure("list_throttle_profiles", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const storedProfiles = readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles);

  if (storedProfiles.length === 0) {
    const defaults = createDefaultThrottleProfiles(workspaceId);
    writeStoredRules(THROTTLE_PROFILES_STORAGE_KEY, defaults);
    return defaults;
  }

  return storedProfiles.filter((profile) => profile.workspaceId === workspaceId);
}

export async function saveThrottleProfile(
  input: Omit<ThrottleProfile, "id"> & { id?: string },
): Promise<ThrottleProfile> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_throttle_profile", {
        input,
      });

      const [savedProfile] = parseThrottleProfiles([payload]);
      return savedProfile!;
    } catch (error) {
      reportCommandFailure("save_throttle_profile", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const profiles = readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles);
  const nextProfile: ThrottleProfile = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  };
  const nextProfiles = upsertStoredEntity(profiles, nextProfile).map((profile) => ({
    ...profile,
    enabled:
      nextProfile.enabled && profile.workspaceId === nextProfile.workspaceId
        ? profile.id === nextProfile.id
        : profile.enabled,
  }));

  writeStoredRules(THROTTLE_PROFILES_STORAGE_KEY, nextProfiles);

  return nextProfiles.find((profile) => profile.id === nextProfile.id) ?? nextProfile;
}

export async function listThrottleRules(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ThrottleRule[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_throttle_rules", {
        input: { workspaceId },
      });

      return parseThrottleRules(payload);
    } catch (error) {
      reportCommandFailure("list_throttle_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(THROTTLE_RULES_STORAGE_KEY, parseThrottleRules).filter(
    (rule) => rule.workspaceId === workspaceId,
  );
}

export async function saveThrottleRule(
  input: Omit<ThrottleRule, "id"> & { id?: string },
): Promise<ThrottleRule> {
  const nextRule: ThrottleRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  };

  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_throttle_rule", {
        input: nextRule,
      });

      const [savedRule] = parseThrottleRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_throttle_rule", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(THROTTLE_RULES_STORAGE_KEY, parseThrottleRules);
  const nextRules = upsertStoredEntity(rules, nextRule);
  writeStoredRules(THROTTLE_RULES_STORAGE_KEY, nextRules);
  return nextRules.find((rule) => rule.id === nextRule.id) ?? nextRule;
}

export async function deleteThrottleRule(ruleId: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invoke("delete_throttle_rule", {
        input: { ruleId },
      });
      return;
    } catch (error) {
      reportCommandFailure("delete_throttle_rule", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  writeStoredRules(
    THROTTLE_RULES_STORAGE_KEY,
    readStoredRules(THROTTLE_RULES_STORAGE_KEY, parseThrottleRules).filter(
      (rule) => rule.id !== ruleId,
    ),
  );
}

export async function setActiveThrottleProfile(input: {
  profileId?: string;
  workspaceId?: string;
}): Promise<void> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;

  if (isTauriRuntime()) {
    try {
      await invoke("set_active_throttle_profile", {
        input: {
          workspaceId,
          ...(input.profileId ? { profileId: input.profileId } : {}),
        },
      });
      return;
    } catch (error) {
      reportCommandFailure("set_active_throttle_profile", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  writeStoredRules(
    THROTTLE_PROFILES_STORAGE_KEY,
    readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles).map((profile) => {
      if (profile.workspaceId !== workspaceId) {
        return profile;
      }

      return {
        ...profile,
        enabled: profile.id === input.profileId,
      };
    }),
  );
}

export async function getThrottleRuntimeStats(): Promise<ThrottleRuntimeStats> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("get_throttle_runtime_stats");
      return parseThrottleRuntimeStats(payload);
    } catch (error) {
      reportCommandFailure("get_throttle_runtime_stats", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return {
    droppedRequests: 0,
    matchedRequests: 0,
    requestDelayMs: 0,
    responseDelayMs: 0,
  };
}

export async function listThrottleSessionTrace(sessionId: string): Promise<ThrottleSessionTrace[]> {
  const importedDetail = getImportedSessionDetail(sessionId);
  if (importedDetail?.throttleTraces) {
    return importedDetail.throttleTraces;
  }

  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_throttle_session_trace", {
        input: { sessionId },
      });

      return parseThrottleSessionTrace(payload);
    } catch (error) {
      reportCommandFailure("list_throttle_session_trace", error, sessionId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return [];
}

export async function listThrottledSessionIds(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<string[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_throttled_session_ids", {
        input: { workspaceId },
      });

      return Array.isArray(payload)
        ? payload.filter((id): id is string => typeof id === "string")
        : [];
    } catch (error) {
      reportCommandFailure("list_throttled_session_ids", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return [];
}
