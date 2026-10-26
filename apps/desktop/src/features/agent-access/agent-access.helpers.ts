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

export type AgentPermissionPreset = "metadata" | "bodies" | "raw" | "full";
/** The reconnect dialog can also preserve a user's custom permission mix. */
export type AgentConnectPreset = AgentPermissionPreset | "current";

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
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
      };
    case "bodies":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: true,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
      };
    case "raw":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: true,
        readWebSocket: true,
        exportSnapshots: false,
        controlCapture: false,
        controlSystemProxy: false,
        manageCertificates: false,
        deleteSessions: false,
      };
    case "full":
      return {
        readSessions: true,
        readBodies: true,
        readRawBodies: false,
        readWebSocket: true,
        exportSnapshots: false,
        controlCapture: true,
        controlSystemProxy: true,
        manageCertificates: true,
        deleteSessions: true,
      };
  }
}

export function presetForPermissions(permissions: AgentAccessPermissions): AgentConnectPreset {
  for (const preset of ["full", "raw", "bodies", "metadata"] as const) {
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
  return (
    current.readSessions === next.readSessions &&
    current.readBodies === next.readBodies &&
    current.readRawBodies === next.readRawBodies &&
    current.readWebSocket === next.readWebSocket &&
    current.exportSnapshots === next.exportSnapshots &&
    current.controlCapture === next.controlCapture &&
    current.controlSystemProxy === next.controlSystemProxy &&
    current.manageCertificates === next.manageCertificates &&
    current.deleteSessions === next.deleteSessions
  );
}
