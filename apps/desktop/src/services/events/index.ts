import { listen } from "@tauri-apps/api/event";
import {
  isWsConnectionStatusEvent,
  isWsMessage,
  parseBreakpointHit,
  parseBreakpointReleased,
  parseSessionSummary,
  type BreakpointHit,
  type BreakpointReleased,
  type SessionRemoveEvent,
  type SessionUpsertEvent,
  type WsConnectionStatusEvent,
  type WsMessage,
} from "@aiproxy/shared-types";
import { logDevWarn } from "../logger/dev-logger";

type Unlisten = () => void;

// L6: guard-based handlers have no thrown error to log; include a bounded
// preview of the rejected payload so the shape regression is still diagnosable.
function payloadPreview(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? String(payload);
  } catch {
    serialized = String(payload);
  }
  return serialized.length > 200 ? `${serialized.slice(0, 197)}...` : serialized;
}

export type MenuEventPayload = {
  menuId: string;
};

export function onMenuEvent(callback: (payload: MenuEventPayload) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("menu-event", (event) => {
    try {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.menuId === "string") {
        callback({ menuId: payload.menuId });
      }
    } catch (error) {
      // L6: surface malformed events to the dev log instead of silently
      // dropping them, so a backend/backend-shape regression is diagnosable.
      logDevWarn("events", "menu_event_parse_failed", { error: String(error) });
    }
  });
}

export function onBreakpointHit(callback: (hit: BreakpointHit) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("breakpoint-hit", (event) => {
    try {
      const hit = parseBreakpointHit(event.payload);
      callback(hit);
    } catch (error) {
      // L6: a silently-swallowed breakpoint hit would leave an interception
      // stuck with no UI feedback and no log; surface it instead.
      logDevWarn("events", "breakpoint_hit_parse_failed", { error: String(error) });
    }
  });
}

/**
 * Fired when a pending breakpoint is released without a user resolution
 * (wait timeout / dropped sender): the request was forwarded unchanged and
 * the frontend must drop the stale hit (review §4.3).
 */
export function onBreakpointReleased(
  callback: (released: BreakpointReleased) => void,
): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("breakpoint-released", (event) => {
    try {
      const released = parseBreakpointReleased(event.payload);
      callback(released);
    } catch (error) {
      logDevWarn("events", "breakpoint_released_parse_failed", { error: String(error) });
    }
  });
}

export function onSessionUpsert(
  callback: (summary: SessionUpsertEvent) => void,
): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("session-upsert", (event) => {
    try {
      callback(parseSessionSummary(event.payload));
    } catch (error) {
      // L6: surface malformed session-upsert events rather than dropping them.
      logDevWarn("events", "session_upsert_parse_failed", { error: String(error) });
    }
  });
}

export function onSessionRemove(
  callback: (sessionId: SessionRemoveEvent) => void,
): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<string>("session-remove", (event) => {
    if (typeof event.payload === "string" && event.payload.length > 0) {
      callback(event.payload);
    } else {
      // L6: a silently-dropped remove leaves a ghost session in the tree.
      logDevWarn("events", "session_remove_parse_failed", {
        payload: payloadPreview(event.payload),
      });
    }
  });
}

export function onSessionsCleared(callback: () => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("sessions-cleared", () => {
    callback();
  });
}

export function onSessionsRemoved(callback: (ids: string[]) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<string[]>("sessions-removed", (event) => {
    if (
      Array.isArray(event.payload) &&
      event.payload.every((id) => typeof id === "string" && id.length > 0)
    ) {
      callback(event.payload);
    } else {
      // L6: element-level check — a non-string id would silently miss every
      // cache removal and leave a ghost session behind.
      logDevWarn("events", "sessions_removed_parse_failed", {
        payload: payloadPreview(event.payload),
      });
    }
  });
}

export function onWsMessage(callback: (message: WsMessage) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("ws-message", (event) => {
    if (isWsMessage(event.payload)) {
      callback(event.payload);
    } else {
      // L6: a silently-dropped message loses captured WS traffic with no trace.
      logDevWarn("events", "ws_message_parse_failed", {
        payload: payloadPreview(event.payload),
      });
    }
  });
}

export function onWsConnectionStatus(
  callback: (event: WsConnectionStatusEvent) => void,
): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("ws-connection-status", (event) => {
    if (isWsConnectionStatusEvent(event.payload)) {
      callback(event.payload);
    } else {
      // L6: a dropped status event would leave the UI stuck on a stale state.
      logDevWarn("events", "ws_connection_status_parse_failed", {
        payload: payloadPreview(event.payload),
      });
    }
  });
}
