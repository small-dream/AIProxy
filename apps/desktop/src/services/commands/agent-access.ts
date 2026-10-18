import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  type AgentAccessSettings,
  type AgentAccessTestResult,
  type AgentAuditLog,
  type AgentClient,
  type InstallAgentClientConfigInput,
  type InstallAgentClientConfigResult,
  type InstallAgentSkillInput,
  type InstallAgentSkillResult,
  type UpdateAgentAccessSettingsInput,
} from "@aiproxy/shared-types";

import { logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

const defaultPermissions = {
  readSessions: true,
  readBodies: false,
  readRawBodies: false,
  readWebSocket: false,
  exportSnapshots: false,
};

const fallbackClients: AgentAccessSettings["clients"] = [
  {
    client: "codex",
    configPath: "~/.codex/config.toml",
    configExists: false,
    configInstalled: false,
    skillPath: "~/.codex/skills/aiproxy/SKILL.md",
    skillInstalled: false,
    skillManaged: false,
    configFormat: "toml",
    configSnippet:
      '[mcp_servers.aiproxy]\ncommand = "<path-to-aiproxy-mcp>"\nargs = ["--data-dir", "<path-to-aiproxy-data>"]\n',
  },
  {
    client: "claude",
    configPath: "~/.claude.json",
    configExists: false,
    configInstalled: false,
    skillPath: "~/.claude/skills/aiproxy/SKILL.md",
    skillInstalled: false,
    skillManaged: false,
    configFormat: "json",
    configSnippet: JSON.stringify(
      {
        mcpServers: {
          aiproxy: {
            type: "stdio",
            command: "<path-to-aiproxy-mcp>",
            args: ["--data-dir", "<path-to-aiproxy-data>"],
          },
        },
      },
      null,
      2,
    ),
  },
  {
    client: "cursor",
    configPath: "~/.cursor/mcp.json",
    configExists: false,
    configInstalled: false,
    skillPath: "~/.cursor/skills/aiproxy/SKILL.md",
    skillInstalled: false,
    skillManaged: false,
    configFormat: "json",
    configSnippet: JSON.stringify(
      {
        mcpServers: {
          aiproxy: {
            command: "<path-to-aiproxy-mcp>",
            args: ["--data-dir", "<path-to-aiproxy-data>"],
          },
        },
      },
      null,
      2,
    ),
  },
];

let fallbackSettings: AgentAccessSettings = {
  version: 2,
  enabled: false,
  transport: "stdio",
  permissions: defaultPermissions,
  limits: {
    maxSessions: 100,
    maxBodyBytes: 256 * 1024,
    maxResponseBytes: 1024 * 1024,
  },
  redaction: {
    detectSensitiveValues: true,
    hashIdentifiers: true,
    customSensitiveKeys: [],
    customPatterns: [],
  },
  updatedAt: null,
  dataDir: "<path-to-aiproxy-data>",
  databasePath: "<path-to-aiproxy-data>/aiproxy.db",
  configPath: "<path-to-aiproxy-data>/agent-access.json",
  auditPath: "<path-to-aiproxy-data>/agent-audit.jsonl",
  configExists: false,
  configError: null,
  sidecarPath: null,
  sidecarAvailable: false,
  sidecarVersion: null,
  clients: fallbackClients,
};

export async function getAgentAccessSettings(): Promise<AgentAccessSettings> {
  if (!isTauriRuntime()) {
    return fallbackSettings;
  }

  try {
    return await invoke<AgentAccessSettings>("get_agent_access_settings");
  } catch (error) {
    reportCommandFailure("get_agent_access_settings", error);
    throw coerceAppError(error);
  }
}

export async function updateAgentAccessSettings(
  input: UpdateAgentAccessSettingsInput,
): Promise<AgentAccessSettings> {
  if (!isTauriRuntime()) {
    fallbackSettings = {
      ...fallbackSettings,
      enabled: input.enabled,
      permissions: input.permissions,
      limits: input.limits,
      redaction: input.redaction,
      updatedAt: new Date().toISOString(),
    };
    return fallbackSettings;
  }

  try {
    logDevInfo("ui.commands", "update_agent_access_settings_requested", {
      enabled: input.enabled,
      readBodies: input.permissions.readBodies,
      readRawBodies: input.permissions.readRawBodies,
      readWebSocket: input.permissions.readWebSocket,
    });
    return await invoke<AgentAccessSettings>("update_agent_access_settings", { input });
  } catch (error) {
    reportCommandFailure("update_agent_access_settings", error);
    throw coerceAppError(error);
  }
}

export async function testAgentAccess(): Promise<AgentAccessTestResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      message: "MCP diagnostics require the desktop runtime.",
    };
  }

  try {
    logDevInfo("ui.commands", "test_agent_access_requested");
    return await invoke<AgentAccessTestResult>("test_agent_access");
  } catch (error) {
    reportCommandFailure("test_agent_access", error);
    throw coerceAppError(error);
  }
}

export async function installAgentSkill(
  input: InstallAgentSkillInput,
): Promise<InstallAgentSkillResult> {
  if (!isTauriRuntime()) {
    return {
      status: "installed",
      client: input.client,
      path: fallbackClients.find((client) => client.client === input.client)?.skillPath ?? "",
      managedExisting: false,
    };
  }

  try {
    logDevInfo("ui.commands", "install_agent_skill_requested", {
      client: input.client,
      overwrite: input.overwrite ?? false,
    });
    return await invoke<InstallAgentSkillResult>("install_agent_skill", { input });
  } catch (error) {
    reportCommandFailure("install_agent_skill", error);
    throw coerceAppError(error);
  }
}

export async function installAgentClientConfig(
  input: InstallAgentClientConfigInput,
): Promise<InstallAgentClientConfigResult> {
  if (!isTauriRuntime()) {
    return {
      status: "installed",
      client: input.client,
      path: fallbackClients.find((client) => client.client === input.client)?.configPath ?? "",
      backupPath: null,
    };
  }

  try {
    logDevInfo("ui.commands", "install_agent_client_config_requested", {
      client: input.client,
    });
    return await invoke<InstallAgentClientConfigResult>("install_agent_client_config", { input });
  } catch (error) {
    reportCommandFailure("install_agent_client_config", error);
    throw coerceAppError(error);
  }
}

export async function getAgentAuditLog(limit = 50): Promise<AgentAuditLog> {
  if (!isTauriRuntime()) {
    return { entries: [], path: fallbackSettings.auditPath, truncated: false };
  }

  try {
    return await invoke<AgentAuditLog>("get_agent_audit_log", { limit });
  } catch (error) {
    reportCommandFailure("get_agent_audit_log", error);
    throw coerceAppError(error);
  }
}

export function isAgentClient(value: string): value is AgentClient {
  return value === "codex" || value === "claude" || value === "cursor";
}
