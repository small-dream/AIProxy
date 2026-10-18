import type { AgentClientInfo } from "@aiproxy/shared-types";

export type AgentClientConnectionState = "connected" | "needsUpdate" | "notConnected";

export function getAgentClientConnectionState(info: AgentClientInfo): AgentClientConnectionState {
  if (info.configInstalled && info.skillInstalled) return "connected";
  if (info.configInstalled || info.skillInstalled) return "needsUpdate";
  return "notConnected";
}

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.configExists;
}
