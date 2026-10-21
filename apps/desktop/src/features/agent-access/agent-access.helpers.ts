import type { AgentAccessPermissions, AgentClientInfo } from "@aiproxy/shared-types";

export type AgentClientConnectionState = "connected" | "needsUpdate" | "notConnected";

export function getAgentClientConnectionState(info: AgentClientInfo): AgentClientConnectionState {
  if (info.configInstalled && info.skillInstalled) return "connected";
  if (info.configInstalled || info.skillInstalled) return "needsUpdate";
  return "notConnected";
}

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.configExists;
}

export type AgentPermissionPreset = "metadata" | "bodies" | "raw";

/**
 * Scenario templates offered when connecting a client. They intentionally set
 * every read permission so the resulting scope is predictable: metadata-only,
 * redacted bodies plus WebSocket, or unredacted bodies.
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
      };
    case "bodies":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: true,
        exportSnapshots: false,
      };
    case "raw":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: true,
        readWebSocket: true,
        exportSnapshots: false,
      };
  }
}

export function presetForPermissions(permissions: AgentAccessPermissions): AgentPermissionPreset {
  if (permissions.readRawBodies) return "raw";
  if (permissions.readBodies) return "bodies";
  return "metadata";
}

export function permissionsEqual(
  current: AgentAccessPermissions,
  next: AgentAccessPermissions,
): boolean {
  return (
    current.readSessions === next.readSessions &&
    current.readBodies === next.readBodies &&
    current.readRawBodies === next.readRawBodies &&
    current.readWebSocket === next.readWebSocket &&
    current.exportSnapshots === next.exportSnapshots
  );
}
