export type AgentClient = "codex" | "claude" | "cursor";

export type AgentAccessPermissions = {
  readSessions: boolean;
  readBodies: boolean;
  readRawBodies: boolean;
  readWebSocket: boolean;
  exportSnapshots: boolean;
  controlCapture: boolean;
  controlSystemProxy: boolean;
  manageCertificates: boolean;
  deleteSessions: boolean;
  sendRequests: boolean;
  manageRules: boolean;
  manageAutomation: boolean;
  manageUserAutomation: boolean;
  manageScripts: boolean;
  manageCrossHostMappings: boolean;
  manageProxiedVerification: boolean;
  manageGlobalAutomation: boolean;
};

export type AgentCapability = keyof AgentAccessPermissions;
export type AgentGrantRequestPolicy = "deny" | "ask";
export type AgentGrantRequestPolicyMap = Record<AgentCapability, AgentGrantRequestPolicy>;
export type AgentGrantStatus =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "expired"
  | "revoked"
  | "denied"
  | "cancelled";
export type AgentGrantApprovalOption = "once" | "fifteenMinutes";

export type AgentGrantScope = {
  sessionIds?: string[];
  connectionIds?: string[];
  host?: string | null;
  pathPrefix?: string | null;
  methods?: string[];
  workspaceId?: string | null;
  automationRoots?: string[];
  origins?: string[];
};

export type AgentGrantResourcePolicy = {
  lifecycle: "ephemeral" | "persistent";
  ttlSeconds?: number | null;
  cleanup: "agentOwnedOnly" | "manual";
};

export type AgentGrantRequest = {
  capability: AgentCapability;
  actionFingerprint: string;
  actionSummary: string;
  scope: AgentGrantScope;
  reason: string;
  approvalOptions: AgentGrantApprovalOption[];
  expiresInSeconds: number;
  nonIdempotent: boolean;
  resourcePolicy?: AgentGrantResourcePolicy | null;
};

export type AgentGrant = {
  id: string;
  requestId: string;
  capability: AgentCapability;
  clientName: string;
  clientVersion: string;
  agentInstanceId: string;
  actionFingerprint: string;
  actionSummary: string;
  scope: AgentGrantScope;
  reason: string;
  createdAt: string;
  approvedAt?: string | null;
  expiresAt: string;
  maxUses: number;
  remainingUses: number;
  resourcePolicy?: AgentGrantResourcePolicy | null;
  status: AgentGrantStatus;
  approvalOption: AgentGrantApprovalOption;
  nonIdempotent: boolean;
  approvalOptions: AgentGrantApprovalOption[];
};

export type AgentAccessGrantList = {
  grants: AgentGrant[];
  pendingCount: number;
  storePath: string;
};

export type ApproveAgentAccessGrantInput = {
  requestId: string;
  option: AgentGrantApprovalOption;
};

export type AgentAccessGrantInput = {
  requestId: string;
};

export type RevokeAgentAccessGrantInput = {
  grantId: string;
};

export type AgentAccessGrantChangedEvent = {
  grant: AgentGrant;
};

export type AgentAccessResidualEffects = {
  captureRunning: boolean;
  systemProxyEnabled: boolean;
  workspaceId?: string | null;
  certificateTrusted: boolean;
  agentRuleCount: number;
  agentAutomationResourceCount: number;
};

export type RevokeAgentControlResult = {
  revokedCapabilities: AgentCapability[];
  retainedReadCapabilities: AgentCapability[];
  activeEffects: AgentAccessResidualEffects;
  grantsCleared: boolean;
};

export type AgentAccessLimits = {
  maxSessions: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
};

export type RedactionAction = "redact" | "hash";

export type RedactionPattern = {
  name: string;
  pattern: string;
  action: RedactionAction;
};

export type AgentAccessRedaction = {
  detectSensitiveValues: boolean;
  hashIdentifiers: boolean;
  customSensitiveKeys: string[];
  customPatterns: RedactionPattern[];
};

export type AgentClientInfo = {
  client: AgentClient;
  configPath: string;
  configExists: boolean;
  configInstalled: boolean;
  skillPath: string;
  skillInstalled: boolean;
  skillManaged: boolean;
  skillVersion?: string | null;
  bundledSkillVersion: string;
  configFormat: "json" | "toml";
  configSnippet: string;
};

export type AgentAccessSettings = {
  version: number;
  enabled: boolean;
  transport: string;
  permissions: AgentAccessPermissions;
  limits: AgentAccessLimits;
  redaction: AgentAccessRedaction;
  automationApprovedRoots: string[];
  proxiedVerificationOrigins: string[];
  automationCrossHostOrigins: string[];
  grantRequestPolicy: AgentGrantRequestPolicyMap;
  automationApprovedRootStatuses: AutomationApprovedRootStatus[];
  updatedAt?: string | null;
  dataDir: string;
  databasePath: string;
  configPath: string;
  auditPath: string;
  configExists: boolean;
  configError?: string | null;
  sidecarPath?: string | null;
  sidecarAvailable: boolean;
  sidecarVersion?: string | null;
  clients: AgentClientInfo[];
};

export type UpdateAgentAccessSettingsInput = {
  enabled: boolean;
  permissions: AgentAccessPermissions;
  limits: AgentAccessLimits;
  redaction: AgentAccessRedaction;
  automationApprovedRoots: string[];
  proxiedVerificationOrigins: string[];
  automationCrossHostOrigins: string[];
  grantRequestPolicy: AgentGrantRequestPolicyMap;
};

export type AutomationApprovedRootStatus = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
};

export type AgentAccessCheckStatus = "ok" | "warning" | "error";

export type AgentAccessCheck = {
  id: string;
  status: AgentAccessCheckStatus;
  detail?: string | null;
};

export type AgentAccessTestResult = {
  ok: boolean;
  message: string;
  sidecarPath?: string | null;
  sidecarVersion?: string | null;
  checks: AgentAccessCheck[];
  details?: Record<string, unknown> | null;
};

export type InstallAgentSkillInput = {
  client: AgentClient;
  overwrite?: boolean;
};

export type InstallAgentSkillStatus = "installed" | "upToDate" | "overwriteRequired";

export type InstallAgentSkillResult = {
  status: InstallAgentSkillStatus;
  client: AgentClient;
  path: string;
  managedExisting: boolean;
};

export type InstallAgentClientConfigInput = {
  client: AgentClient;
};

export type InstallAgentClientConfigResult = {
  status: "installed" | "upToDate";
  client: AgentClient;
  path: string;
  backupPath?: string | null;
};

export type RemoveAgentClientConfigInput = {
  client: AgentClient;
  removeSkill?: boolean;
};

export type RemoveAgentClientConfigResult = {
  status: "removed" | "notInstalled";
  client: AgentClient;
  path: string;
  backupPath?: string | null;
  skillRemoved: boolean;
  skillSkipped: boolean;
  skillError?: string | null;
};

export type AgentAuditEntry = {
  timestamp?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  tool?: string | null;
  actionSummary?: string | null;
  agentControl?: boolean | null;
  outcome?: string | null;
  durationMs?: number | null;
  returnedBytes?: number | null;
  redacted?: boolean | null;
  truncated?: boolean | null;
  errorCode?: string | null;
};

export type AgentAuditLog = {
  entries: AgentAuditEntry[];
  path: string;
  truncated: boolean;
};

export type AgentControlActionEvent = {
  eventId: string;
  timestamp: string;
  method: string;
  actionSummary?: string | null;
  ok: boolean;
  errorCode?: string | null;
  durationMs: number;
};

export function parseAgentControlActionEvent(value: unknown): AgentControlActionEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AgentControlActionEvent>;
  if (
    typeof candidate.eventId !== "string" ||
    candidate.eventId.length === 0 ||
    typeof candidate.timestamp !== "string" ||
    candidate.timestamp.length === 0 ||
    typeof candidate.method !== "string" ||
    candidate.method.length === 0 ||
    (candidate.actionSummary !== undefined &&
      candidate.actionSummary !== null &&
      typeof candidate.actionSummary !== "string") ||
    typeof candidate.ok !== "boolean" ||
    (candidate.errorCode !== undefined &&
      candidate.errorCode !== null &&
      typeof candidate.errorCode !== "string") ||
    typeof candidate.durationMs !== "number" ||
    !Number.isFinite(candidate.durationMs)
  ) {
    return null;
  }
  return {
    eventId: candidate.eventId,
    timestamp: candidate.timestamp,
    method: candidate.method,
    actionSummary: typeof candidate.actionSummary === "string" ? candidate.actionSummary : null,
    ok: candidate.ok,
    errorCode: typeof candidate.errorCode === "string" ? candidate.errorCode : null,
    durationMs: candidate.durationMs,
  };
}
