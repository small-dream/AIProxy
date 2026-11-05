import type {
  AgentAccessPermissions,
  AgentClientInfo,
  AgentGrantRequestPolicyMap,
} from "@aiproxy/shared-types";

import type { TranslationKey } from "@/i18n";

import { AGENT_PERMISSION_KEYS, availablePermissionDefinitions } from "./agent-access.permissions";

export type AgentClientConnectionState = "connected" | "needsUpdate" | "notConnected";

export function getAgentClientConnectionState(info: AgentClientInfo): AgentClientConnectionState {
  if (info.configInstalled && info.skillInstalled) return "connected";
  if (info.configInstalled || info.skillInstalled) return "needsUpdate";
  return "notConnected";
}

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.configExists;
}

export type AgentPermissionPreset = "readOnly" | "fullControl";
export type AgentPresetSelection = AgentPermissionPreset | "custom";
export type AgentConnectPreset = AgentPresetSelection;

export type AgentPermissionAccess = {
  permissions: AgentAccessPermissions;
  grantRequestPolicy: AgentGrantRequestPolicyMap;
};

export const AGENT_PERMISSION_PRESETS: readonly AgentPermissionPreset[] = [
  "readOnly",
  "fullControl",
] as const;

export function presetLabelKey(preset: AgentConnectPreset): TranslationKey {
  switch (preset) {
    case "readOnly":
      return "settingsPage.agentAccess.presetReadOnly";
    case "fullControl":
      return "settingsPage.agentAccess.presetFullControl";
    case "custom":
      return "settingsPage.agentAccess.presetCustom";
  }
}

export function presetDescriptionKey(preset: AgentConnectPreset): TranslationKey {
  switch (preset) {
    case "readOnly":
      return "settingsPage.agentAccess.presetReadOnlyDescription";
    case "fullControl":
      return "settingsPage.agentAccess.presetFullControlDescription";
    case "custom":
      return "settingsPage.agentAccess.presetCustomDescription";
  }
}

/**
 * Scenario templates offered when connecting a client. They intentionally set
 * every permission so the resulting scope is predictable. Optional add-ons
 * such as raw bodies, WebSocket, proxy verification, and capture control stay
 * explicit instead of being bundled into a scenario.
 */
export function permissionsForPreset(preset: AgentPermissionPreset): AgentAccessPermissions {
  const permissions = Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((key) => [key, false]),
  ) as AgentAccessPermissions;

  switch (preset) {
    case "readOnly":
      return {
        ...permissions,
        readSessions: true,
        readBodies: true,
      };
    case "fullControl": {
      for (const definition of availablePermissionDefinitions()) {
        permissions[definition.key] = true;
      }
      return permissions;
    }
  }
}

export function deniedGrantRequestPolicy(): AgentGrantRequestPolicyMap {
  return Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((capability) => [capability, "deny"]),
  ) as AgentGrantRequestPolicyMap;
}

export function accessForPreset(preset: AgentPermissionPreset): AgentPermissionAccess {
  return {
    permissions: permissionsForPreset(preset),
    grantRequestPolicy: deniedGrantRequestPolicy(),
  };
}

export function presetForPermissions(permissions: AgentAccessPermissions): AgentPresetSelection {
  for (const preset of AGENT_PERMISSION_PRESETS) {
    if (permissionsEqual(permissions, permissionsForPreset(preset))) return preset;
  }
  return "custom";
}

/**
 * Resolve the access represented by the connect dialog. "custom" keeps the
 * exact saved permission mix so reconnecting never silently revokes a user's
 * partial control grants or other custom settings.
 */
export function accessForConnectPreset(
  preset: AgentConnectPreset,
  current: AgentPermissionAccess,
): AgentPermissionAccess {
  return preset === "custom"
    ? {
        permissions: { ...current.permissions },
        grantRequestPolicy: { ...current.grantRequestPolicy },
      }
    : accessForPreset(preset);
}

export function permissionsEqual(
  current: AgentAccessPermissions,
  next: AgentAccessPermissions,
): boolean {
  return AGENT_PERMISSION_KEYS.every((key) => current[key] === next[key]);
}

export function grantRequestPoliciesEqual(
  current: AgentGrantRequestPolicyMap,
  next: AgentGrantRequestPolicyMap,
): boolean {
  return AGENT_PERMISSION_KEYS.every((key) => current[key] === next[key]);
}
