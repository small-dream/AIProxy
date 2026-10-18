export type AgentClient = "codex" | "claude" | "cursor";

export type AgentAccessPermissions = {
  readSessions: boolean;
  readBodies: boolean;
  readRawBodies: boolean;
  readWebSocket: boolean;
  exportSnapshots: boolean;
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
};

export type AgentAccessTestResult = {
  ok: boolean;
  message: string;
  sidecarPath?: string | null;
  sidecarVersion?: string | null;
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

export type AgentAuditEntry = {
  timestamp?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  tool?: string | null;
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
