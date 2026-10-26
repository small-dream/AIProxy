import { invoke } from "@tauri-apps/api/core";
import { parseAgentControlActionEvent, type AgentControlActionEvent } from "@aiproxy/shared-types";

import { logDevWarn } from "@/services/logger/dev-logger";

import { isTauriRuntime } from "./runtime";

/**
 * Read the bounded backend replay buffer. A control action can finish before
 * the renderer has mounted its event listener when the desktop was launched by
 * an Agent, so the initial action must be recoverable without persisting it.
 */
export async function getRecentAgentControlActions(): Promise<AgentControlActionEvent[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const payload = await invoke<unknown>("get_recent_agent_control_actions");
    if (!Array.isArray(payload)) {
      logDevWarn("commands", "recent_agent_control_actions_not_an_array");
      return [];
    }
    return payload
      .map(parseAgentControlActionEvent)
      .filter((event): event is AgentControlActionEvent => event !== null);
  } catch (error) {
    logDevWarn("commands", "recent_agent_control_actions_failed", { error });
    return [];
  }
}
