import type { AgentClientInfo } from "@aiproxy/shared-types";

export type AgentClientConnectionState =
  | "connected"
  | "needsUpdate"
  | "notConnected"
  | "projectLevel";

export function getAgentClientConnectionState(info: AgentClientInfo): AgentClientConnectionState {
  if (info.client === "claude") return "projectLevel";
  if (info.configInstalled && info.skillInstalled) return "connected";
  if (info.configExists || info.configInstalled || info.skillInstalled) return "needsUpdate";
  return "notConnected";
}

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.client === "claude" || info.configExists;
}
