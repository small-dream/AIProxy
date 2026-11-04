import type { AgentAccessPermissions, AgentClientInfo } from "@aiproxy/shared-types";

import type { TranslationKey } from "@/i18n";

import { AGENT_PERMISSION_KEYS } from "./agent-access.permissions";

export type AgentClientConnectionState = "connected" | "needsUpdate" | "notConnected";

export function getAgentClientConnectionState(info: AgentClientInfo): AgentClientConnectionState {
  if (info.configInstalled && info.skillInstalled) return "connected";
  if (info.configInstalled || info.skillInstalled) return "needsUpdate";
  return "notConnected";
}

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.configExists;
}

export type AgentPermissionPreset =
  | "metadata"
  | "readOnly"
  | "debugReplay"
  | "automationExperiment";
/** The reconnect dialog can also preserve a user's custom permission mix. */
export type AgentConnectPreset = AgentPermissionPreset | "current";

export const AGENT_PERMISSION_PRESETS: readonly AgentPermissionPreset[] = [
  "metadata",
  "readOnly",
  "debugReplay",
  "automationExperiment",
] as const;

export function presetLabelKey(preset: AgentConnectPreset): TranslationKey {
  switch (preset) {
    case "metadata":
      return "settingsPage.agentAccess.presetMetadata";
    case "readOnly":
      return "settingsPage.agentAccess.presetReadOnly";
    case "debugReplay":
      return "settingsPage.agentAccess.presetDebugReplay";
    case "automationExperiment":
      return "settingsPage.agentAccess.presetAutomationExperiment";
    case "current":
      return "settingsPage.agentAccess.presetCurrent";
  }
}

export function presetDescriptionKey(preset: AgentConnectPreset): TranslationKey {
  switch (preset) {
    case "metadata":
      return "settingsPage.agentAccess.presetMetadataDescription";
    case "readOnly":
      return "settingsPage.agentAccess.presetReadOnlyDescription";
    case "debugReplay":
      return "settingsPage.agentAccess.presetDebugReplayDescription";
    case "automationExperiment":
      return "settingsPage.agentAccess.presetAutomationExperimentDescription";
    case "current":
      return "settingsPage.agentAccess.presetCurrentDescription";
  }
}

/**
 * Scenario templates offered when connecting a client. They intentionally set
 * every permission so the resulting scope is predictable. Optional add-ons
 * such as raw bodies, WebSocket, proxy verification, and capture control stay
 * explicit instead of being bundled into a scenario.
 */
export function permissionsForPreset(preset: AgentPermissionPreset): AgentAccessPermissions {
  switch (preset) {
    case "metadata":
      return {
        readSessions: true,
        readBodies: false,
        readRawBodies: false,
        readWebSocket: false,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
        sendRequests: false,
        manageRules: false,
        manageAutomation: false,
        manageUserAutomation: false,
        manageScripts: false,
        manageCrossHostMappings: false,
        manageProxiedVerification: false,
        manageGlobalAutomation: false,
      };
    case "readOnly":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: false,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
        sendRequests: false,
        manageRules: false,
        manageAutomation: false,
        manageUserAutomation: false,
        manageScripts: false,
        manageCrossHostMappings: false,
        manageProxiedVerification: false,
        manageGlobalAutomation: false,
      };
    case "debugReplay":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: false,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
        sendRequests: true,
        manageRules: false,
        manageAutomation: false,
        manageUserAutomation: false,
        manageScripts: false,
        manageCrossHostMappings: false,
        manageProxiedVerification: false,
        manageGlobalAutomation: false,
      };
    case "automationExperiment":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: false,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
        sendRequests: false,
        manageRules: false,
        manageAutomation: true,
        manageUserAutomation: false,
        manageScripts: false,
        manageCrossHostMappings: false,
        manageProxiedVerification: false,
        manageGlobalAutomation: false,
      };
  }
}

export function presetForPermissions(permissions: AgentAccessPermissions): AgentConnectPreset {
  for (const preset of AGENT_PERMISSION_PRESETS) {
    if (permissionsEqual(permissions, permissionsForPreset(preset))) return preset;
  }
  return "current";
}

/**
 * Resolve the permissions represented by the connect dialog. "current" keeps
 * the exact saved permission mix so reconnecting never silently revokes a
 * user's partial control grants or other custom settings.
 */
export function permissionsForConnectPreset(
  preset: AgentConnectPreset,
  current: AgentAccessPermissions,
): AgentAccessPermissions {
  return preset === "current" ? { ...current } : permissionsForPreset(preset);
}

export function permissionsEqual(
  current: AgentAccessPermissions,
  next: AgentAccessPermissions,
): boolean {
  return AGENT_PERMISSION_KEYS.every((key) => current[key] === next[key]);
}
