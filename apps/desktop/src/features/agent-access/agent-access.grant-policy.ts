import type {
  AgentAccessPermissions,
  AgentCapability,
  AgentGrantRequestPolicyMap,
} from "@aiproxy/shared-types";

import type { TranslationKey } from "@/i18n";

import { AGENT_PERMISSION_KEYS, permissionDefinition } from "./agent-access.permissions";

export type AgentCapabilityMode = "deny" | "ask" | "always";

const DENY_BY_DEFAULT: ReadonlySet<AgentCapability> = new Set([
  "readSessions",
  "controlSystemProxy",
  "manageCertificates",
  "deleteSessions",
  "manageScripts",
  "manageCrossHostMappings",
  "manageUserAutomation",
  "manageGlobalAutomation",
]);

export function capabilitySupportsTemporaryApproval(capability: AgentCapability): boolean {
  return capability !== "readSessions";
}

export function defaultGrantRequestPolicy(): AgentGrantRequestPolicyMap {
  return Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((capability) => [
      capability,
      DENY_BY_DEFAULT.has(capability) ? "deny" : "ask",
    ]),
  ) as AgentGrantRequestPolicyMap;
}

export function capabilityMode(
  permissions: AgentAccessPermissions,
  policy: AgentGrantRequestPolicyMap,
  capability: AgentCapability,
): AgentCapabilityMode {
  if (permissions[capability]) return "always";
  return policy[capability] === "ask" && capabilitySupportsTemporaryApproval(capability)
    ? "ask"
    : "deny";
}

export function applyCapabilityMode(
  permissions: AgentAccessPermissions,
  policy: AgentGrantRequestPolicyMap,
  capability: AgentCapability,
  mode: AgentCapabilityMode,
): { permissions: AgentAccessPermissions; grantRequestPolicy: AgentGrantRequestPolicyMap } {
  const nextPermissions = { ...permissions, [capability]: mode === "always" };
  if (capability === "readBodies" && mode !== "always") {
    nextPermissions.readRawBodies = false;
  }
  const nextPolicy = { ...policy };
  if (mode !== "always") {
    nextPolicy[capability] =
      mode === "ask" && !capabilitySupportsTemporaryApproval(capability) ? "deny" : mode;
  }
  return { permissions: nextPermissions, grantRequestPolicy: nextPolicy };
}

export function capabilityModeLabelKey(mode: AgentCapabilityMode): TranslationKey {
  switch (mode) {
    case "deny":
      return "settingsPage.agentAccess.capabilityModeDeny";
    case "ask":
      return "settingsPage.agentAccess.capabilityModeAsk";
    case "always":
      return "settingsPage.agentAccess.capabilityModeAlways";
  }
}

/**
 * Treat moving a high-impact capability out of "blocked" as an elevation even
 * when the new state only asks for temporary approval. The grant still permits
 * a real action, so it must pass the same second confirmation as a permanent
 * permission change.
 */
export function requiresAccessChangeConfirmation(
  beforePermissions: AgentAccessPermissions,
  beforePolicy: AgentGrantRequestPolicyMap,
  afterPermissions: AgentAccessPermissions,
  afterPolicy: AgentGrantRequestPolicyMap,
): boolean {
  return AGENT_PERMISSION_KEYS.some((capability) => {
    const definition = permissionDefinition(capability);
    if (!definition.confirmOnEnable) return false;
    const beforeMode = capabilityMode(beforePermissions, beforePolicy, capability);
    const afterMode = capabilityMode(afterPermissions, afterPolicy, capability);
    return (
      (beforeMode === "deny" && afterMode !== "deny") ||
      (beforeMode !== "always" && afterMode === "always")
    );
  });
}
