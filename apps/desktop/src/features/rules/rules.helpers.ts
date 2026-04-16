import type {
  BreakpointRule,
  BreakpointStage,
  MapRule,
  RewriteRule,
  RewriteRuleType,
  RuleMatch,
} from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const DEFAULT_WORKSPACE_ID = "default";

export type RulesTabValue = "breakpoint" | "rewrite" | "mapLocal" | "mapRemote";
export type TranslationFn = ReturnType<typeof useI18n>["t"];

/* ── Factory helpers ──────────────────────────────────────────────── */

function createEmptyRuleMatch(): RuleMatch {
  return { urlPattern: "", methods: [], stage: "either" };
}

export function createEmptyBreakpointRule(): BreakpointRule {
  return { id: crypto.randomUUID(), enabled: true, urlPattern: "", methods: [], stage: "request" };
}

export function createEmptyRewriteRule(rewriteType: RewriteRuleType = "header"): RewriteRule {
  const base = {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    enabled: true,
    priority: 100,
    match: createEmptyRuleMatch(),
    note: "",
  };

  switch (rewriteType) {
    case "query":
      return { ...base, rewriteType, payload: { operation: "set", paramName: "", value: "" } };
    case "body":
      return { ...base, rewriteType, payload: { contentType: "application/json", target: "response", text: "" } };
    case "redirect":
      return { ...base, rewriteType, payload: { preservePath: true, preserveQuery: true, targetUrl: "" } };
    case "header":
    default:
      return { ...base, rewriteType: "header", payload: { headerName: "", operation: "set", target: "request", value: "" } };
  }
}

export function createEmptyMapRule(mode: MapRule["mode"]): MapRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    mode,
    name: "",
    enabled: true,
    priority: 100,
    sourcePattern: "",
    targetValue: "",
    preservePath: true,
    preserveQuery: true,
    note: "",
  };
}

export function createCatchAllRule(stage: BreakpointStage): BreakpointRule {
  return { id: crypto.randomUUID(), enabled: true, urlPattern: "*", methods: [], stage };
}

/* ── Validation helpers ───────────────────────────────────────────── */

export function getRewriteValidationErrors(rule: RewriteRule, t: TranslationFn): string[] {
  const errors: string[] = [];
  if (!rule.name.trim()) errors.push(t("rulesPage.validation.ruleNameRequired"));
  if (!rule.match.urlPattern.trim()) errors.push(t("rulesPage.validation.urlPatternRequired"));

  if (rule.rewriteType === "header") {
    if (!rule.payload.headerName.trim()) errors.push(t("rulesPage.validation.headerNameRequired"));
    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim()) errors.push(t("rulesPage.validation.headerValueRequired"));
  }
  if (rule.rewriteType === "query") {
    if (!rule.payload.paramName.trim()) errors.push(t("rulesPage.validation.queryNameRequired"));
    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim()) errors.push(t("rulesPage.validation.queryValueRequired"));
  }
  if (rule.rewriteType === "body" && !rule.payload.text.trim()) errors.push(t("rulesPage.validation.bodyTextRequired"));
  if (rule.rewriteType === "redirect" && !rule.payload.targetUrl.trim()) errors.push(t("rulesPage.validation.redirectTargetRequired"));

  return errors;
}

export function getMapValidationErrors(rule: MapRule, t: TranslationFn): string[] {
  const errors: string[] = [];
  if (!rule.name.trim()) errors.push(t("rulesPage.validation.ruleNameRequired"));
  if (!rule.sourcePattern.trim()) errors.push(t("rulesPage.validation.mapSourceRequired"));
  if (!rule.targetValue.trim()) errors.push(rule.mode === "local" ? t("rulesPage.validation.localTargetRequired") : t("rulesPage.validation.remoteTargetRequired"));
  return errors;
}

/* ── Label / format helpers ───────────────────────────────────────── */

export function getRewriteTypeLabel(rewriteType: RewriteRuleType, t: TranslationFn) {
  switch (rewriteType) {
    case "header": return t("rulesPage.rewrite.types.header");
    case "query": return t("rulesPage.rewrite.types.query");
    case "body": return t("rulesPage.rewrite.types.body");
    case "redirect": return t("rulesPage.rewrite.types.redirect");
  }
}

export function formatRuleMatch(match: RuleMatch): string {
  const methods = match.methods.length === 0 ? "ALL" : match.methods.join(", ");
  return `${methods} • ${match.urlPattern || "*"}`;
}
