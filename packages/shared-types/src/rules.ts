import { coerceAppError, isNullableString } from "./common";
import {
  type BodyReference,
  type HeaderEntry,
  isHeaderEntry,
  normalizeBodyReference,
} from "./sessions";

export type BreakpointStage = "request" | "response";

export type BreakpointActionKind = "forward" | "drop" | "mock";

export type MockResponse = {
  statusCode: number;
  headers: HeaderEntry[];
  bodyBase64?: string;
};

export type BreakpointRule = {
  id: string;
  enabled: boolean;
  urlPattern: string;
  methods: string[];
  stage: BreakpointStage;
  matchType?: MatchType;
};

export type BreakpointHit = {
  sessionId: string;
  stage: BreakpointStage;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: HeaderEntry[];
  requestBody?: BodyReference;
  responseStatusCode?: number;
  responseHeaders?: HeaderEntry[];
  responseBody?: BodyReference;
};

export type BreakpointReleaseReason = "timeout" | "senderDropped";

/**
 * Frontend mirror of BREAKPOINT_WAIT_TIMEOUT in crates/proxy-core/src/lib.rs
 * (5 minutes). The backend does not send the deadline with breakpoint-hit, so
 * the countdown is driven by this constant; the authoritative release signal
 * is always the `breakpoint-released` event.
 */
export const BREAKPOINT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export type BreakpointReleased = {
  sessionId: string;
  stage: BreakpointStage;
  reason: BreakpointReleaseReason;
};

export type BreakpointResolution = {
  sessionId: string;
  action: BreakpointActionKind;
  mock?: MockResponse;
  modifiedRequestHeaders?: HeaderEntry[];
  modifiedRequestQueryParams?: HeaderEntry[];
  modifiedRequestBodyBase64?: string;
  modifiedResponseStatusCode?: number;
  modifiedResponseHeaders?: HeaderEntry[];
  modifiedResponseBodyBase64?: string;
};

export type RuleMatchStage = "request" | "response" | "either";

export type MatchType = "contains" | "wildcard" | "exact" | "regex";

export type RuleMatch = {
  urlPattern: string;
  methods: string[];
  stage: RuleMatchStage;
  matchType?: MatchType;
};

export type RewriteRuleType = "header" | "query" | "body" | "redirect";

export type RewriteTarget = "request" | "response";

export type RewriteHeaderPayload = {
  headerName: string;
  operation: "set" | "remove";
  target: RewriteTarget;
  value?: string;
};

export type RewriteQueryPayload = {
  operation: "set" | "remove";
  paramName: string;
  value?: string;
};

export type RewriteBodyFieldEdit = {
  operation: "set" | "remove";
  path: string;
  value?: string;
  valueType?: "string" | "number" | "boolean" | "null" | "json";
};

export type RewriteBodyPayload = {
  contentType: string;
  fields?: RewriteBodyFieldEdit[];
  mode?: "replace" | "fields";
  target: RewriteTarget;
  text?: string;
};

export type RewriteRedirectPayload = {
  preservePath: boolean;
  preserveQuery: boolean;
  targetUrl: string;
};

type RewriteRuleBase = {
  enabled: boolean;
  id: string;
  match: RuleMatch;
  name: string;
  note?: string;
  priority: number;
  workspaceId: string;
};

export type RewriteRule =
  | (RewriteRuleBase & {
      payload: RewriteHeaderPayload;
      rewriteType: "header";
    })
  | (RewriteRuleBase & {
      payload: RewriteQueryPayload;
      rewriteType: "query";
    })
  | (RewriteRuleBase & {
      payload: RewriteBodyPayload;
      rewriteType: "body";
    })
  | (RewriteRuleBase & {
      payload: RewriteRedirectPayload;
      rewriteType: "redirect";
    });

export type MapRuleMode = "local" | "remote";

export type MapRule = {
  enabled: boolean;
  id: string;
  mode: MapRuleMode;
  name: string;
  note?: string;
  preservePath: boolean;
  preserveQuery: boolean;
  priority: number;
  sourcePattern: string;
  targetValue: string;
  workspaceId: string;
};

export type MapSessionTrace = {
  durationMs: number;
  localPath?: string;
  mappedUrl?: string;
  mode: MapRuleMode;
  originalUrl: string;
  outcome: "success" | "failed" | string;
  ruleId: string;
  ruleName: string;
  sourcePattern: string;
  targetValue: string;
};

export type ExportFormat = "har" | "curl" | "json";
export type ExportScope = "selected" | "filtered" | "all";

export type DnsMappingRule = {
  enabled: boolean;
  hostPattern: string;
  id: string;
  name: string;
  note?: string;
  priority: number;
  targetIp: string;
  workspaceId: string;
};

export type ScriptRuleLanguage = "javascript" | "typescript";

export type ScriptRuleSourceType = "inline" | "fileImport";

export type ScriptEntrypoints = {
  onRequest: boolean;
  onResponse: boolean;
};

export type ScriptRule = {
  enabled: boolean;
  entrypoints: ScriptEntrypoints;
  id: string;
  language: ScriptRuleLanguage;
  match: RuleMatch;
  name: string;
  note?: string;
  priority: number;
  sourceCode: string;
  sourcePath?: string;
  sourceType: ScriptRuleSourceType;
  workspaceId: string;
};

export type ScriptLogLevel = "debug" | "info" | "warn" | "error";

export type ScriptRunEntryKind = "log" | "extraction" | "error";

export type ScriptRunOutcome =
  | "success"
  | "skipped"
  | "runtimeError"
  | "timedOut"
  | "invalidResult";

export type ScriptRunEntry = {
  kind: ScriptRunEntryKind;
  key?: string;
  level?: ScriptLogLevel;
  message?: string;
  payloadJson?: string;
  sequence: number;
};

export type ScriptSessionTrace = {
  durationMs: number;
  entries: ScriptRunEntry[];
  outcome: ScriptRunOutcome;
  ruleId: string;
  stage: "request" | "response";
};

export type RewriteRunOutcome = "success" | "skipped" | "failed";

export type RewriteRunEntry = {
  after?: string;
  before?: string;
  kind: "body-field" | "header" | "query" | "body" | "redirect" | "skip" | "error";
  key?: string;
  message?: string;
  sequence: number;
};

export type RewriteSessionTrace = {
  durationMs: number;
  entries: RewriteRunEntry[];
  outcome: RewriteRunOutcome;
  rewriteType: RewriteRuleType;
  ruleId: string;
  ruleName: string;
  stage: "request" | "response";
};

export type ScriptSourceFile = {
  fileName: string;
  language: ScriptRuleLanguage;
  path: string;
  sourceCode: string;
};

export function isBreakpointHit(value: unknown): value is BreakpointHit {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakpointHit>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.stage === "request" || candidate.stage === "response") &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.path === "string" &&
    Array.isArray(candidate.requestHeaders) &&
    candidate.requestHeaders.every(isHeaderEntry)
  );
}

export function parseBreakpointHit(value: unknown): BreakpointHit {
  if (!isBreakpointHit(value)) {
    throw coerceAppError(value);
  }
  const candidate = value as BreakpointHit & {
    requestBody?: BodyReference | null;
    responseStatusCode?: number | null;
    responseHeaders?: HeaderEntry[] | null;
    responseBody?: BodyReference | null;
  };
  return {
    sessionId: candidate.sessionId,
    stage: candidate.stage,
    method: candidate.method,
    url: candidate.url,
    host: candidate.host,
    path: candidate.path,
    requestHeaders: candidate.requestHeaders,
    ...(candidate.requestBody !== null && candidate.requestBody !== undefined
      ? {
          requestBody: normalizeBodyReference(
            candidate.requestBody as BodyReference & Record<string, unknown>,
          ),
        }
      : {}),
    ...(candidate.responseStatusCode !== null && candidate.responseStatusCode !== undefined
      ? { responseStatusCode: candidate.responseStatusCode }
      : {}),
    ...(candidate.responseHeaders !== null && candidate.responseHeaders !== undefined
      ? { responseHeaders: candidate.responseHeaders }
      : {}),
    ...(candidate.responseBody !== null && candidate.responseBody !== undefined
      ? {
          responseBody: normalizeBodyReference(
            candidate.responseBody as BodyReference & Record<string, unknown>,
          ),
        }
      : {}),
  };
}

export function isBreakpointReleased(value: unknown): value is BreakpointReleased {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakpointReleased>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.stage === "request" || candidate.stage === "response") &&
    (candidate.reason === "timeout" || candidate.reason === "senderDropped")
  );
}

export function parseBreakpointReleased(value: unknown): BreakpointReleased {
  if (!isBreakpointReleased(value)) {
    throw coerceAppError(value);
  }
  return {
    sessionId: value.sessionId,
    stage: value.stage,
    reason: value.reason,
  };
}

export function isBreakpointRule(value: unknown): value is BreakpointRule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakpointRule>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.urlPattern === "string" &&
    Array.isArray(candidate.methods) &&
    (candidate.stage === "request" || candidate.stage === "response")
  );
}

export function parseBreakpointRules(value: unknown): BreakpointRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }
  if (value.every(isBreakpointRule)) {
    return value;
  }
  throw coerceAppError(value);
}

export function isRuleMatch(value: unknown): value is RuleMatch {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<RuleMatch>;

  return (
    typeof candidate.urlPattern === "string" &&
    Array.isArray(candidate.methods) &&
    candidate.methods.every((method) => typeof method === "string") &&
    (candidate.stage === "request" ||
      candidate.stage === "response" ||
      candidate.stage === "either")
  );
}

function isRewriteHeaderPayload(value: unknown): value is RewriteHeaderPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteHeaderPayload>;
  return (
    typeof candidate.headerName === "string" &&
    (candidate.operation === "set" || candidate.operation === "remove") &&
    (candidate.target === "request" || candidate.target === "response") &&
    isNullableString(candidate.value)
  );
}

function isRewriteQueryPayload(value: unknown): value is RewriteQueryPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteQueryPayload>;
  return (
    typeof candidate.paramName === "string" &&
    (candidate.operation === "set" || candidate.operation === "remove") &&
    isNullableString(candidate.value)
  );
}

function isRewriteBodyPayload(value: unknown): value is RewriteBodyPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteBodyPayload>;
  return (
    typeof candidate.contentType === "string" &&
    isNullableString(candidate.text) &&
    (candidate.mode === undefined || candidate.mode === "replace" || candidate.mode === "fields") &&
    (candidate.fields === undefined || candidate.fields.every(isRewriteBodyFieldEdit)) &&
    (candidate.target === "request" || candidate.target === "response")
  );
}

function isRewriteBodyFieldEdit(value: unknown): value is RewriteBodyFieldEdit {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteBodyFieldEdit>;
  return (
    typeof candidate.path === "string" &&
    (candidate.operation === "set" || candidate.operation === "remove") &&
    isNullableString(candidate.value) &&
    (candidate.valueType === undefined ||
      candidate.valueType === "string" ||
      candidate.valueType === "number" ||
      candidate.valueType === "boolean" ||
      candidate.valueType === "null" ||
      candidate.valueType === "json")
  );
}

function isRewriteRedirectPayload(value: unknown): value is RewriteRedirectPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteRedirectPayload>;
  return (
    typeof candidate.targetUrl === "string" &&
    typeof candidate.preservePath === "boolean" &&
    typeof candidate.preserveQuery === "boolean"
  );
}

export function isRewriteRule(value: unknown): value is RewriteRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<RewriteRule>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.priority !== "number" ||
    !isNullableString(candidate.note) ||
    !isRuleMatch(candidate.match)
  ) {
    return false;
  }

  if (candidate.rewriteType === "header") {
    return isRewriteHeaderPayload(candidate.payload);
  }

  if (candidate.rewriteType === "query") {
    return isRewriteQueryPayload(candidate.payload);
  }

  if (candidate.rewriteType === "body") {
    return isRewriteBodyPayload(candidate.payload);
  }

  if (candidate.rewriteType === "redirect") {
    return isRewriteRedirectPayload(candidate.payload);
  }

  return false;
}

export function parseRewriteRules(value: unknown): RewriteRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isRewriteRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function isMapRule(value: unknown): value is MapRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<MapRule>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    (candidate.mode === "local" || candidate.mode === "remote") &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.priority === "number" &&
    typeof candidate.sourcePattern === "string" &&
    typeof candidate.targetValue === "string" &&
    typeof candidate.preservePath === "boolean" &&
    typeof candidate.preserveQuery === "boolean" &&
    isNullableString(candidate.note)
  );
}

export function parseMapRules(value: unknown): MapRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isMapRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function isDnsMappingRule(value: unknown): value is DnsMappingRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<DnsMappingRule>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.hostPattern === "string" &&
    typeof candidate.targetIp === "string" &&
    typeof candidate.priority === "number"
  );
}

export function parseDnsMappings(value: unknown): DnsMappingRule[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isDnsMappingRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function isScriptEntrypoints(value: unknown): value is ScriptEntrypoints {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ScriptEntrypoints>;
  return typeof candidate.onRequest === "boolean" && typeof candidate.onResponse === "boolean";
}

export function isScriptRule(value: unknown): value is ScriptRule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ScriptRule>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.priority === "number" &&
    isNullableString(candidate.note) &&
    isRuleMatch(candidate.match) &&
    (candidate.language === "javascript" || candidate.language === "typescript") &&
    (candidate.sourceType === "inline" || candidate.sourceType === "fileImport") &&
    typeof candidate.sourceCode === "string" &&
    isNullableString(candidate.sourcePath) &&
    isScriptEntrypoints(candidate.entrypoints)
  );
}

export function parseScriptRules(value: unknown): ScriptRule[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isScriptRule)) return value;
  throw coerceAppError(value);
}

export function isScriptRunEntry(value: unknown): value is ScriptRunEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ScriptRunEntry>;
  return (
    (candidate.kind === "log" || candidate.kind === "extraction" || candidate.kind === "error") &&
    (candidate.level === undefined ||
      candidate.level === "debug" ||
      candidate.level === "info" ||
      candidate.level === "warn" ||
      candidate.level === "error") &&
    isNullableString(candidate.key) &&
    isNullableString(candidate.message) &&
    isNullableString(candidate.payloadJson) &&
    typeof candidate.sequence === "number"
  );
}

export function isScriptSessionTrace(value: unknown): value is ScriptSessionTrace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ScriptSessionTrace>;
  return (
    typeof candidate.durationMs === "number" &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isScriptRunEntry) &&
    (candidate.outcome === "success" ||
      candidate.outcome === "skipped" ||
      candidate.outcome === "runtimeError" ||
      candidate.outcome === "timedOut" ||
      candidate.outcome === "invalidResult") &&
    typeof candidate.ruleId === "string" &&
    (candidate.stage === "request" || candidate.stage === "response")
  );
}

export function parseScriptSessionTrace(value: unknown): ScriptSessionTrace[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isScriptSessionTrace)) return value;
  throw coerceAppError(value);
}

export function isRewriteRunEntry(value: unknown): value is RewriteRunEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteRunEntry>;
  return (
    (candidate.kind === "body-field" ||
      candidate.kind === "header" ||
      candidate.kind === "query" ||
      candidate.kind === "body" ||
      candidate.kind === "redirect" ||
      candidate.kind === "skip" ||
      candidate.kind === "error") &&
    isNullableString(candidate.after) &&
    isNullableString(candidate.before) &&
    isNullableString(candidate.key) &&
    isNullableString(candidate.message) &&
    typeof candidate.sequence === "number"
  );
}

export function isRewriteSessionTrace(value: unknown): value is RewriteSessionTrace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteSessionTrace>;
  return (
    typeof candidate.durationMs === "number" &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isRewriteRunEntry) &&
    (candidate.outcome === "success" ||
      candidate.outcome === "skipped" ||
      candidate.outcome === "failed") &&
    (candidate.rewriteType === "header" ||
      candidate.rewriteType === "query" ||
      candidate.rewriteType === "body" ||
      candidate.rewriteType === "redirect") &&
    typeof candidate.ruleId === "string" &&
    typeof candidate.ruleName === "string" &&
    (candidate.stage === "request" || candidate.stage === "response")
  );
}

export function parseRewriteSessionTrace(value: unknown): RewriteSessionTrace[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isRewriteSessionTrace)) return value;
  throw coerceAppError(value);
}

export function isMapSessionTrace(value: unknown): value is MapSessionTrace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MapSessionTrace>;
  return (
    typeof candidate.durationMs === "number" &&
    isNullableString(candidate.localPath) &&
    isNullableString(candidate.mappedUrl) &&
    (candidate.mode === "local" || candidate.mode === "remote") &&
    typeof candidate.originalUrl === "string" &&
    typeof candidate.outcome === "string" &&
    typeof candidate.ruleId === "string" &&
    typeof candidate.ruleName === "string" &&
    typeof candidate.sourcePattern === "string" &&
    typeof candidate.targetValue === "string"
  );
}

export function parseMapSessionTrace(value: unknown): MapSessionTrace[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isMapSessionTrace)) return value;
  throw coerceAppError(value);
}

export function isScriptSourceFile(value: unknown): value is ScriptSourceFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ScriptSourceFile>;
  return (
    typeof candidate.fileName === "string" &&
    (candidate.language === "javascript" || candidate.language === "typescript") &&
    typeof candidate.path === "string" &&
    typeof candidate.sourceCode === "string"
  );
}

export function parseScriptSourceFile(value: unknown): ScriptSourceFile {
  if (!isScriptSourceFile(value)) throw coerceAppError(value);
  return value;
}

// ---------------------------------------------------------------------------
// API Collection type guards
// ---------------------------------------------------------------------------
