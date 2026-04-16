import { listen } from "@tauri-apps/api/event";
import {
  parseBreakpointHit,
  parseSessionDetail,
  type BreakpointHit,
  type SessionDetail,
} from "@aiproxy/shared-types";

type Unlisten = () => void;

export async function subscribeToProxyStatus(): Promise<Unlisten> {
  return () => undefined;
}

export function onBreakpointHit(callback: (hit: BreakpointHit) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("breakpoint-hit", (event) => {
    try {
      const hit = parseBreakpointHit(event.payload);
      callback(hit);
    } catch {
      // Ignore malformed events
    }
  });
}

export function onSessionUpsert(callback: (detail: SessionDetail) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<unknown>("session-upsert", (event) => {
    try {
      const detail = parseSessionDetail(event.payload);
      callback(detail);
    } catch {
      // Ignore malformed events
    }
  });
}

export function onSessionRemove(callback: (sessionId: string) => void): Promise<Unlisten> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve(() => {});
  }

  return listen<string>("session-remove", (event) => {
    if (typeof event.payload === "string" && event.payload.length > 0) {
      callback(event.payload);
    }
  });
}
