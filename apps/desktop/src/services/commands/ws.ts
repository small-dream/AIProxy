import { invoke } from "@tauri-apps/api/core";
import {
  coerceAppError,
  parseWsMessages,
  type WsConnectionStatusValue,
  type WsInjectInput,
  type WsMessage,
} from "@aiproxy/shared-types";

import {
  logDevDebug,
  logDevInfo,
} from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export async function listWsMessages(
  sessionId: string,
  limit?: number,
  offset?: number,
): Promise<WsMessage[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_ws_messages_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    logDevDebug("ui.commands", "list_ws_messages_requested", { sessionId });
    const payload = await invoke<unknown>("list_ws_messages", {
      input: { sessionId, limit, offset },
    });
    const messages = parseWsMessages(payload);
    logDevDebug("ui.commands", "list_ws_messages_succeeded", {
      sessionId,
      count: messages.length,
    });
    return messages;
  } catch (error) {
    reportCommandFailure("list_ws_messages", error);
    throw coerceAppError(error);
  }
}

export async function getWsConnectionStatus(
  sessionId: string,
): Promise<WsConnectionStatusValue> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_ws_connection_status_bypassed_non_tauri_runtime");
    return "closed";
  }

  try {
    const result = await invoke<{ status: string }>(
      "get_ws_connection_status",
      { input: { sessionId } },
    );
    return result.status === "active" ? "active" : "closed";
  } catch (error) {
    reportCommandFailure("get_ws_connection_status", error);
    return "closed";
  }
}

export async function injectWsMessage(input: WsInjectInput): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "inject_ws_message_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "inject_ws_message_requested", {
      sessionId: input.sessionId,
      direction: input.direction,
      opcode: input.opcode,
      payloadLength: input.payload.length,
    });
    await invoke("inject_ws_message", { input });
    logDevInfo("ui.commands", "inject_ws_message_succeeded", {
      sessionId: input.sessionId,
      direction: input.direction,
      opcode: input.opcode,
    });
  } catch (error) {
    reportCommandFailure("inject_ws_message", error, input.sessionId);
    throw coerceAppError(error);
  }
}

export async function searchWsMessages(
  sessionId: string,
  query: string,
  limit?: number,
  offset?: number,
): Promise<WsMessage[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "search_ws_messages_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    const payload = await invoke<unknown>("search_ws_messages", {
      input: { sessionId, query, limit, offset },
    });
    return parseWsMessages(payload);
  } catch (error) {
    reportCommandFailure("search_ws_messages", error);
    throw coerceAppError(error);
  }
}
