import { listen } from "@tauri-apps/api/event";
import { parseBreakpointHit, type BreakpointHit } from "@pharles/shared-types";

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
