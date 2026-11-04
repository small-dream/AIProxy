import type { MatchType, MapRuleMode, RewriteAction, RewriteRuleType } from "./rules";
import type { HeaderEntry } from "./sessions";

export type AutomationScope = "workspace" | "global";
export type AutomationLifecycle = "persistent" | "ephemeral";
export type AutomationKind =
  | "rewrite"
  | "map"
  | "dns"
  | "script"
  | "throttleProfile"
  | "throttleRule"
  | "breakpoint";
export type AutomationVerificationMode = "offline" | "proxy" | "external";
export type AutomationVerificationStatus =
  | "passed"
  | "not_matched"
  | "shadowed"
  | "rule_failed"
  | "upstream_failed"
  | "assertion_failed"
  | "insufficient_evidence"
  | "expired";

export type AutomationRewriteMatch = {
  methods?: string[];
  stage?: string;
  urlPattern: string;
  matchType?: MatchType;
};

export type AutomationRewriteResource = {
  enabled?: boolean;
  name: string;
  note?: string;
  priority?: number;
  match: AutomationRewriteMatch;
  rewriteType?: RewriteRuleType;
  actions: RewriteAction[];
  payload?: Record<string, unknown>;
};

export type AutomationMapResource = {
  enabled?: boolean;
  mode: MapRuleMode;
  name: string;
  note?: string;
  preservePath?: boolean;
  preserveQuery?: boolean;
  priority?: number;
  sourcePattern: string;
  approvedPath?: string;
  targetValue?: string;
  managedAssetRef?: string;
  matchType?: MatchType;
};

export type AutomationAsset = {
  ref: string;
  fileName: string;
  contentBase64: string;
  contentType?: string;
};

export type AutomationUpsert<T> = {
  id?: string;
  expectedVersion?: string;
  ref?: string;
  resource: T;
};

export type AutomationUpserts = {
  rewrite?: AutomationUpsert<AutomationRewriteResource>[];
  map?: AutomationUpsert<AutomationMapResource>[];
  dns?: unknown[];
  script?: unknown[];
  throttleProfile?: unknown[];
  throttleRule?: unknown[];
  breakpoint?: unknown[];
};

export type AutomationDelete = {
  kind: AutomationKind;
  id: string;
  expectedVersion: string;
};

export type AutomationPlan = {
  scope: AutomationScope;
  workspaceId?: string;
  lifecycle: AutomationLifecycle;
  ttlSeconds?: number;
  idempotencyKey: string;
  upserts: AutomationUpserts;
  deletes?: AutomationDelete[];
  activation?: {
    throttleProfileId?: string | null;
    throttleProfileRef?: string;
    expectedActiveProfileId?: string | null;
  };
  assets?: AutomationAsset[];
};

export type ValidateAutomationPlanInput = {
  plan: AutomationPlan;
};

export type ApplyAutomationPlanInput = {
  plan: AutomationPlan;
  expectedPlanHash: string;
  expectedScopeHash: string;
};

export type ListAutomationResourcesInput = {
  scope?: AutomationScope;
  workspaceId?: string;
  kind?: AutomationKind;
  lifecycle?: AutomationLifecycle;
  cursor?: string;
  limit?: number;
};

export type GetAutomationResourceInput = {
  kind: AutomationKind;
  id: string;
};

export type AutomationResourceSummary = {
  kind: AutomationKind;
  id: string;
  version: string;
  name: string;
  enabled: boolean;
  priority: number;
  scope: AutomationScope;
  workspaceId?: string | null;
  owner: "agent" | "user";
  lifecycle: AutomationLifecycle;
  expiresAt?: string | null;
  changeId?: string | null;
  experimentStatus?: string | null;
};

export type AutomationResourceView = AutomationResourceSummary & {
  resource: AutomationRewriteResource | AutomationMapResource | Record<string, unknown>;
};

export type AutomationResourceList = {
  items: AutomationResourceSummary[];
  nextCursor?: string | null;
};

export type AutomationPlanResource = {
  kind: AutomationKind;
  id?: string | null;
  ref?: string | null;
  operation: "create" | "update" | "delete";
  owner: "agent" | "user";
  version?: string | null;
};

export type AutomationValidationResult = {
  planHash: string;
  scopeHash: string;
  canApply: boolean;
  warnings: string[];
  resources: AutomationPlanResource[];
  summary: string;
};

export type AutomationApplyResult = {
  changeId: string;
  status: string;
  runtimeGeneration: number;
  resourceIdsByRef: Record<string, string>;
  expiresAt?: string | null;
  idempotent: boolean;
};

export type AutomationVerificationRequest = {
  ref: string;
  baselineSessionId?: string;
  method?: string;
  url?: string;
  headers?: HeaderEntry[];
  body?: string;
  jsonSet?: Record<string, unknown>;
};

export type AutomationAssertionSubject =
  | "status"
  | "requestHeader"
  | "responseHeader"
  | "responseBody"
  | "queryParam"
  | "ruleTrace"
  | "durationMs";

export type AutomationAssertionOperator =
  | "equals"
  | "contains"
  | "exists"
  | "notExists"
  | "gte"
  | "lte";

export type AutomationAssertion = {
  id: string;
  subject: AutomationAssertionSubject;
  path?: string;
  operator: AutomationAssertionOperator;
  expected?: unknown;
};

export type VerifyAutomationChangeInput = {
  changeId: string;
  mode: AutomationVerificationMode;
  baselineSessionIds?: string[];
  requests?: AutomationVerificationRequest[];
  externalSessionIds?: string[];
  assertions: AutomationAssertion[];
};

export type AutomationAssertionResult = {
  id: string;
  subject: AutomationAssertionSubject;
  path?: string | null;
  passed: boolean;
  message: string;
  actual?: unknown;
};

export type AutomationConflictCandidate = {
  ruleId: string;
  ruleName?: string;
  priority: number;
  matchType?: string;
  scope?: string;
  workspaceId?: string | null;
  sourcePattern?: string;
  outcome?: string;
  reason?: string;
};

export type AutomationConflictDiagnostic = {
  winningRuleId?: string | null;
  candidates?: AutomationConflictCandidate[];
};

export type AutomationVerificationRequestResult = {
  ref: string;
  status: AutomationVerificationStatus;
  matchedRuleIds: string[];
  assertions: AutomationAssertionResult[];
  evidenceSessionIds: string[];
  ruleTraceRefs: string[];
  responseStatus?: number | null;
  finalUrl?: string | null;
  conflict?: AutomationConflictDiagnostic | null;
};

export type AutomationVerificationResult = {
  verificationId?: string | null;
  changeId: string;
  experimentId: string;
  mode: AutomationVerificationMode;
  evidenceLevel: AutomationVerificationMode;
  runtimeGeneration: number;
  status: AutomationVerificationStatus;
  requests: AutomationVerificationRequestResult[];
  baselineSessionIds: string[];
  evidenceSessionIds: string[];
  limitations: string[];
};

export type AutomationExperiment = {
  id: string;
  changeId: string;
  objective: string;
  baselineSessionIds: string[];
  status: string;
  cleanupState: string;
  createdAt: string;
  updatedAt: string;
};

export type AutomationVerificationRecord = {
  id: string;
  experimentId: string;
  mode: AutomationVerificationMode;
  request: AutomationVerificationRequest[];
  assertions: AutomationAssertion[];
  result: AutomationVerificationResult;
  evidenceSessionIds: string[];
  limitations: string[];
  createdAt: string;
};

export type AutomationChangeItem = {
  resourceKind: AutomationKind;
  resourceId: string;
  operation: "create" | "update" | "delete";
  versionBefore?: string | null;
  versionAfter?: string | null;
  before?: unknown;
  after?: unknown;
  dependencies?: unknown;
};

export type AutomationChangeView = {
  changeId: string;
  scope: AutomationScope;
  workspaceId?: string | null;
  lifecycle: AutomationLifecycle;
  status: string;
  planHash: string;
  scopeHashBefore: string;
  scopeHashAfter: string;
  runtimeGeneration?: number | null;
  createdAt: string;
  activatedAt?: string | null;
  expiresAt?: string | null;
  items: AutomationChangeItem[];
  experiment?: AutomationExperiment | null;
  verifications: AutomationVerificationRecord[];
  rollbackScopeHash: string;
};

export type GetAutomationChangeInput = {
  changeId: string;
};

export type RollbackAutomationChangeInput = {
  changeId: string;
  expectedScopeHash: string;
};

export type ClearAgentAutomationInput = {
  scope: AutomationScope;
  workspaceId?: string;
  lifecycle: AutomationLifecycle | "all";
};

export type ClearAgentAutomationResult = {
  clearedChangeIds: string[];
  clearedResourceCount: number;
  runtimeGeneration: number;
};

export type AutomationChangedEvent = {
  reason: string;
  changeId?: string | null;
  changeIds: string[];
  runtimeGeneration: number;
  scope?: AutomationScope | null;
  workspaceId?: string | null;
  lifecycle?: AutomationLifecycle | null;
  status?: string | null;
  affectedResources?: Array<{
    kind: AutomationKind;
    id: string;
    operation: string;
  }>;
  experimentId?: string | null;
  cleanupState?: string | null;
  timestamp: string;
};

export function parseAutomationChangedEvent(value: unknown): AutomationChangedEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.reason !== "string" ||
    !Array.isArray(record.changeIds) ||
    !record.changeIds.every((id) => typeof id === "string") ||
    typeof record.runtimeGeneration !== "number" ||
    !Number.isFinite(record.runtimeGeneration) ||
    typeof record.timestamp !== "string"
  ) {
    return null;
  }
  const optionalString = (key: string) =>
    typeof record[key] === "string" || record[key] === null || record[key] === undefined;
  if (
    !optionalString("changeId") ||
    !optionalString("scope") ||
    !optionalString("workspaceId") ||
    !optionalString("lifecycle") ||
    !optionalString("status") ||
    !optionalString("experimentId") ||
    !optionalString("cleanupState")
  ) {
    return null;
  }
  if (
    record.affectedResources !== undefined &&
    (!Array.isArray(record.affectedResources) ||
      !record.affectedResources.every(
        (resource) =>
          resource &&
          typeof resource === "object" &&
          typeof (resource as Record<string, unknown>).kind === "string" &&
          typeof (resource as Record<string, unknown>).id === "string" &&
          typeof (resource as Record<string, unknown>).operation === "string",
      ))
  ) {
    return null;
  }
  return record as AutomationChangedEvent;
}
