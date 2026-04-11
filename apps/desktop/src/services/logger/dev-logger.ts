type DevLogLevel = "debug" | "error" | "info" | "warn";

type DevLogContext = Record<string, unknown>;

type DevLogEntry = {
  component: string;
  context: DevLogContext;
  event: string;
  level: DevLogLevel;
  occurredAt: string;
};

declare global {
  interface Window {
    __PHARLES_DEV_LOGS__?: DevLogEntry[];
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

  console[consoleMethod]("[PharlesUI]", entry);

  if (typeof window !== "undefined") {
    const previousLogs = window.__PHARLES_DEV_LOGS__ ?? [];
    const nextLogs = [...previousLogs, entry].slice(-200);

    window.__PHARLES_DEV_LOGS__ = nextLogs;
  }
}
