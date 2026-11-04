import type { AgentAccessPermissions } from "@aiproxy/shared-types";

import type { TranslationKey } from "@/i18n";

export const AGENT_PERMISSION_KEYS = [
  "readSessions",
  "readBodies",
  "readRawBodies",
  "readWebSocket",
  "exportSnapshots",
  "controlCapture",
  "controlSystemProxy",
  "manageCertificates",
  "deleteSessions",
  "sendRequests",
  "manageRules",
  "manageAutomation",
  "manageUserAutomation",
  "manageScripts",
  "manageCrossHostMappings",
  "manageProxiedVerification",
  "manageGlobalAutomation",
] as const satisfies readonly (keyof AgentAccessPermissions)[];

export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number];
export type AgentPermissionGroupId =
  | "readData"
  | "controlDesktop"
  | "modifyRequests"
  | "agentAutomation"
  | "dangerous";
export type AgentPermissionRisk = "read" | "sensitive" | "traffic" | "destructive";
export type AgentPermissionSurface = "standard" | "advanced";

export type AgentPermissionDefinition = {
  key: AgentPermissionKey;
  targetId: string;
  group: AgentPermissionGroupId;
  risk: AgentPermissionRisk;
  surface: AgentPermissionSurface;
  available: boolean;
  confirmOnEnable: boolean;
  requires: readonly AgentPermissionKey[];
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
};

export type AgentPermissionGroupDefinition = {
  id: AgentPermissionGroupId;
  risk: AgentPermissionRisk;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
};

const permissionTargetIds: Record<AgentPermissionKey, string> = {
  readSessions: "agent-read-sessions",
  readBodies: "agent-read-bodies",
  readRawBodies: "agent-read-raw-bodies",
  readWebSocket: "agent-read-websocket",
  exportSnapshots: "agent-export-snapshots",
  controlCapture: "agent-control-capture",
  controlSystemProxy: "agent-control-system-proxy",
  manageCertificates: "agent-control-certificates",
  deleteSessions: "agent-control-delete-sessions",
  sendRequests: "agent-send-requests",
  manageRules: "agent-manage-rules",
  manageAutomation: "agent-manage-automation",
  manageUserAutomation: "agent-manage-user-automation",
  manageScripts: "agent-manage-scripts",
  manageCrossHostMappings: "agent-manage-cross-host-mappings",
  manageProxiedVerification: "agent-manage-proxied-verification",
  manageGlobalAutomation: "agent-manage-global-automation",
};

export const AGENT_PERMISSION_MATRIX_TARGET_ID = "agent-permissions";

export const AGENT_ADVANCED_PERMISSION_TARGET_IDS: readonly string[] = [
  permissionTargetIds.readRawBodies,
  "agent-detect-sensitive-values",
  "agent-hash-identifiers",
  "agent-custom-sensitive-keys",
  "agent-max-sessions",
  "agent-max-body-bytes",
];

const permissionMatrixTargetIds = new Set([
  AGENT_PERMISSION_MATRIX_TARGET_ID,
  ...Object.values(permissionTargetIds),
  ...AGENT_ADVANCED_PERMISSION_TARGET_IDS,
]);

export const AGENT_PERMISSION_GROUPS: readonly AgentPermissionGroupDefinition[] = [
  {
    id: "readData",
    risk: "read",
    labelKey: "settingsPage.agentAccess.permissionGroupReadData",
    descriptionKey: "settingsPage.agentAccess.permissionGroupReadDataDescription",
  },
  {
    id: "controlDesktop",
    risk: "traffic",
    labelKey: "settingsPage.agentAccess.permissionGroupControlDesktop",
    descriptionKey: "settingsPage.agentAccess.permissionGroupControlDesktopDescription",
  },
  {
    id: "modifyRequests",
    risk: "traffic",
    labelKey: "settingsPage.agentAccess.permissionGroupModifyRequests",
    descriptionKey: "settingsPage.agentAccess.permissionGroupModifyRequestsDescription",
  },
  {
    id: "agentAutomation",
    risk: "traffic",
    labelKey: "settingsPage.agentAccess.permissionGroupAutomation",
    descriptionKey: "settingsPage.agentAccess.permissionGroupAutomationDescription",
  },
  {
    id: "dangerous",
    risk: "destructive",
    labelKey: "settingsPage.agentAccess.permissionGroupDangerous",
    descriptionKey: "settingsPage.agentAccess.permissionGroupDangerousDescription",
  },
] as const;

export const AGENT_PERMISSION_DEFINITIONS: readonly AgentPermissionDefinition[] = [
  permission("readSessions", "readData", "read", "standard", false),
  permission("readBodies", "readData", "sensitive", "standard", false),
  permission("readRawBodies", "readData", "sensitive", "advanced", true, true, ["readBodies"]),
  permission("readWebSocket", "readData", "read", "standard", false),
  permission("exportSnapshots", "readData", "read", "standard", false, false),
  permission("controlCapture", "controlDesktop", "traffic", "standard", false),
  permission("controlSystemProxy", "controlDesktop", "traffic", "standard", true),
  permission("manageCertificates", "controlDesktop", "destructive", "standard", true),
  permission("deleteSessions", "dangerous", "destructive", "standard", true),
  permission("sendRequests", "modifyRequests", "traffic", "standard", true),
  permission("manageRules", "modifyRequests", "traffic", "standard", true),
  permission("manageAutomation", "agentAutomation", "traffic", "standard", true),
  permission("manageUserAutomation", "agentAutomation", "destructive", "standard", true),
  permission("manageScripts", "agentAutomation", "traffic", "standard", true, false),
  permission("manageCrossHostMappings", "modifyRequests", "traffic", "standard", true, false),
  permission("manageProxiedVerification", "modifyRequests", "traffic", "standard", true, true, [
    "manageAutomation",
  ]),
  permission("manageGlobalAutomation", "agentAutomation", "traffic", "standard", true, false),
] as const;

const definitionByKey = new Map(
  AGENT_PERMISSION_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function permissionDefinition(key: AgentPermissionKey): AgentPermissionDefinition {
  const definition = definitionByKey.get(key);
  if (!definition) {
    throw new Error(`Missing Agent permission definition for ${key}`);
  }
  return definition;
}

export function availablePermissionDefinitions({
  surface,
  group,
}: {
  surface?: AgentPermissionSurface;
  group?: AgentPermissionGroupId;
} = {}): readonly AgentPermissionDefinition[] {
  return AGENT_PERMISSION_DEFINITIONS.filter(
    (definition) =>
      definition.available &&
      (surface === undefined || definition.surface === surface) &&
      (group === undefined || definition.group === group),
  );
}

export function enabledPermissionDefinitions(
  permissions: AgentAccessPermissions,
  options: { surface?: AgentPermissionSurface; group?: AgentPermissionGroupId } = {},
): readonly AgentPermissionDefinition[] {
  return availablePermissionDefinitions(options).filter(
    (definition) => permissions[definition.key],
  );
}

export function countEnabledPermissions(
  permissions: AgentAccessPermissions,
  options: { surface?: AgentPermissionSurface; group?: AgentPermissionGroupId } = {},
): number {
  return enabledPermissionDefinitions(permissions, options).length;
}

export function permissionRiskKey(risk: AgentPermissionRisk): TranslationKey {
  switch (risk) {
    case "read":
      return "settingsPage.agentAccess.permissionRiskRead";
    case "sensitive":
      return "settingsPage.agentAccess.permissionRiskSensitive";
    case "traffic":
      return "settingsPage.agentAccess.permissionRiskTraffic";
    case "destructive":
      return "settingsPage.agentAccess.permissionRiskDestructive";
  }
}

export function requiresPermissionConfirmation(
  before: AgentAccessPermissions,
  after: AgentAccessPermissions,
): boolean {
  return AGENT_PERMISSION_DEFINITIONS.some(
    (definition) => definition.confirmOnEnable && !before[definition.key] && after[definition.key],
  );
}

export function hasUnmetPermissionDependencies(
  permissions: AgentAccessPermissions,
  key: AgentPermissionKey,
): boolean {
  return permissionDefinition(key).requires.some((dependency) => !permissions[dependency]);
}

export function isAgentPermissionMatrixTarget(targetId: string): boolean {
  return permissionMatrixTargetIds.has(targetId);
}

export function isAgentAdvancedPermissionTarget(targetId: string): boolean {
  return AGENT_ADVANCED_PERMISSION_TARGET_IDS.includes(targetId);
}

function permission(
  key: AgentPermissionKey,
  group: AgentPermissionGroupId,
  risk: AgentPermissionRisk,
  surface: AgentPermissionSurface,
  confirmOnEnable: boolean,
  available = true,
  requires: readonly AgentPermissionKey[] = [],
): AgentPermissionDefinition {
  const prefix = `settingsPage.agentAccess.${key}`;
  return {
    key,
    targetId: permissionTargetIds[key],
    group,
    risk,
    surface,
    available,
    confirmOnEnable,
    requires,
    labelKey: `${prefix}Label` as TranslationKey,
    descriptionKey: `${prefix}Description` as TranslationKey,
  };
}
