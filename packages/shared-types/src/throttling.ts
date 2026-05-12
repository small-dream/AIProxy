import { coerceAppError, isNullableString } from "./common";

export type ThrottleProfile = {
  downloadKbps: number;
  enabled: boolean;
  id: string;
  latencyMs: number;
  name: string;
  note?: string;
  packetLossRatio: number;
  preset: boolean;
  uploadKbps: number;
  workspaceId: string;
};

export type ThrottleRule = {
  enabled: boolean;
  id: string;
  methods: string[];
  name: string;
  note?: string;
  priority: number;
  profileId: string;
  stage: "both" | "request" | "response";
  urlPattern: string;
  workspaceId: string;
};

export type ThrottleRuntimeStats = {
  droppedRequests: number;
  matchedRequests: number;
  requestDelayMs: number;
  responseDelayMs: number;
};

export type ThrottleSessionTrace = {
  bodyBytes: number;
  delayMs: number;
  latencyMs: number;
  message?: string;
  outcome: "applied" | "dropped" | string;
  profileId: string;
  profileName: string;
  ruleId?: string;
  ruleName?: string;
  sequence: number;
  stage: "request" | "response" | string;
  transferDelayMs: number;
};

export function isThrottleProfile(value: unknown): value is ThrottleProfile {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<ThrottleProfile>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.latencyMs === "number" &&
    typeof candidate.uploadKbps === "number" &&
    typeof candidate.downloadKbps === "number" &&
    typeof candidate.packetLossRatio === "number" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.preset === "boolean" &&
    isNullableString(candidate.note)
  );
}

export function isThrottleRule(value: unknown): value is ThrottleRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<ThrottleRule>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    isNullableString(candidate.note) &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.priority === "number" &&
    typeof candidate.profileId === "string" &&
    typeof candidate.urlPattern === "string" &&
    Array.isArray(candidate.methods) &&
    candidate.methods.every((method) => typeof method === "string") &&
    (candidate.stage === "both" || candidate.stage === "request" || candidate.stage === "response")
  );
}

export function isThrottleRuntimeStats(value: unknown): value is ThrottleRuntimeStats {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<ThrottleRuntimeStats>;

  return (
    typeof candidate.droppedRequests === "number" &&
    typeof candidate.matchedRequests === "number" &&
    typeof candidate.requestDelayMs === "number" &&
    typeof candidate.responseDelayMs === "number"
  );
}

export function isThrottleSessionTrace(value: unknown): value is ThrottleSessionTrace {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<ThrottleSessionTrace>;

  return (
    typeof candidate.bodyBytes === "number" &&
    typeof candidate.delayMs === "number" &&
    typeof candidate.latencyMs === "number" &&
    isNullableString(candidate.message) &&
    typeof candidate.outcome === "string" &&
    typeof candidate.profileId === "string" &&
    typeof candidate.profileName === "string" &&
    isNullableString(candidate.ruleId) &&
    isNullableString(candidate.ruleName) &&
    typeof candidate.sequence === "number" &&
    typeof candidate.stage === "string" &&
    typeof candidate.transferDelayMs === "number"
  );
}

export function parseThrottleProfiles(value: unknown): ThrottleProfile[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isThrottleProfile)) {
    return value;
  }

  throw coerceAppError(value);
}

export function parseThrottleRules(value: unknown): ThrottleRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isThrottleRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function parseThrottleRuntimeStats(value: unknown): ThrottleRuntimeStats {
  if (isThrottleRuntimeStats(value)) {
    return value;
  }

  throw coerceAppError(value);
}

export function parseThrottleSessionTrace(value: unknown): ThrottleSessionTrace[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isThrottleSessionTrace)) {
    return value;
  }

  throw coerceAppError(value);
}
