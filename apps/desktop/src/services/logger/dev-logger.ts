type DevLogLevel = "debug" | "error" | "info" | "warn";

type DevLogContext = Record<string, unknown>;

type DevLogEntry = {
  component: string;
  context: DevLogContext;
  event: string;
  level: DevLogLevel;
  occurredAt: string;
};

// L10: capacity of the in-memory dev-log ring buffer. The previous
// implementation rebuilt the whole array (`[...prev, entry].slice(-200)`) on
// every emit, an O(n) allocation on the main thread scaled by log volume (this
// runs from nearly every command wrapper and high-frequency event paths).
const DEV_LOG_RING_CAPACITY = 200;

declare global {
  interface Window {
    __AIPROXY_DEV_LOGS__?: DevLogEntry[];
  }
}

export function logDevDebug(component: string, event: string, context: DevLogContext = {}) {
  emitDevLog("debug", component, event, context);
}

export function logDevInfo(component: string, event: string, context: DevLogContext = {}) {
  emitDevLog("info", component, event, context);
}

export function logDevWarn(component: string, event: string, context: DevLogContext = {}) {
  emitDevLog("warn", component, event, context);
}

export function logDevError(component: string, event: string, context: DevLogContext = {}) {
  emitDevLog("error", component, event, context);
}

function emitDevLog(level: DevLogLevel, component: string, event: string, context: DevLogContext) {
  const entry: DevLogEntry = {
    component,
    context,
    event,
    level,
    occurredAt: new Date().toISOString(),
  };
  const consoleMethod = level === "debug" ? "debug" : level === "info" ? "info" : level;

  console[consoleMethod]("[AIProxyUI]", entry);

  if (typeof window !== "undefined") {
    // O(1) amortized: push in place and drop the oldest only when over
    // capacity. Avoids re-allocating/copying the full buffer on every emit.
    const logs = window.__AIPROXY_DEV_LOGS__ ?? (window.__AIPROXY_DEV_LOGS__ = []);
    logs.push(entry);
    if (logs.length > DEV_LOG_RING_CAPACITY) {
      logs.splice(0, logs.length - DEV_LOG_RING_CAPACITY);
    }
  }
}
