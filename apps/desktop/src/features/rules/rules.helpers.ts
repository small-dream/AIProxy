import type {
  BreakpointRule,
  BreakpointStage,
  DnsMappingRule,
  MapRule,
  RewriteAction,
  RewriteRule,
  RewriteRuleType,
  RuleMatch,
  ScriptRule,
} from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const DEFAULT_WORKSPACE_ID = "default";

export type RulesTabValue = "breakpoint" | "rewrite" | "mapping" | "script";
export type TranslationFn = ReturnType<typeof useI18n>["t"];

/* ── Factory helpers ──────────────────────────────────────────────── */

function createEmptyRuleMatch(): RuleMatch {
  return { urlPattern: "", methods: [], stage: "either" };
}

export function createEmptyBreakpointRule(): BreakpointRule {
  return { id: crypto.randomUUID(), enabled: true, urlPattern: "", methods: [], stage: "request" };
}

export function createEmptyRewriteAction(rewriteType: RewriteRuleType): RewriteAction {
  switch (rewriteType) {
    case "query":
      return { rewriteType, payload: { operation: "set", paramName: "", value: "" } };
    case "body":
      return {
        rewriteType,
        payload: {
          contentType: "application/json",
          fields: [{ operation: "set", path: "", value: "", valueType: "string" }],
          mode: "replace",
          target: "response",
          text: "",
        },
      };
    case "redirect":
      return {
        rewriteType,
        payload: { preservePath: true, preserveQuery: true, targetUrl: "" },
      };
    case "header":
    default:
      return {
        rewriteType: "header",
        payload: { headerName: "", operation: "set", target: "request", value: "" },
      };
  }
}

export function createEmptyRewriteRule(rewriteType: RewriteRuleType = "header"): RewriteRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    enabled: true,
    priority: 100,
    match: createEmptyRuleMatch(),
    note: "",
    rewriteType,
    actions: [createEmptyRewriteAction(rewriteType)],
  };
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

export function createEmptyDnsMappingRule(): DnsMappingRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    enabled: true,
    priority: 100,
    hostPattern: "",
    targetIp: "",
    note: "",
  };
}

export function createEmptyScriptRule(language: ScriptRule["language"] = "typescript"): ScriptRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    enabled: true,
    priority: 100,
    match: createEmptyRuleMatch(),
    note: "",
    language,
    sourceType: "inline",
    sourceCode:
      language === "typescript"
        ? 'export function onRequest(ctx) {\n  ctx.request.setHeader("x-script", "enabled");\n}\n'
        : 'export function onRequest(ctx) {\n  ctx.request.setHeader("x-script", "enabled");\n}\n',
    entrypoints: {
      onRequest: true,
      onResponse: false,
    },
  };
}

function isValidIpAddress(ip: string): boolean {
  // IPv4
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(ip)) {
    return ip.split(".").every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6 (basic check)
  const ipv6 = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv6.test(ip);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getDnsMappingValidationErrors(
  rule: DnsMappingRule,
  t: TranslationFn,
): RuleFieldErrors {
  const errors: RuleFieldErrors = {};
  if (!rule.name.trim()) errors.name = t("rulesPage.validation.ruleNameRequired");
  if (!rule.hostPattern.trim())
    errors.hostPattern = t("rulesPage.validation.dnsHostPatternRequired");
  if (!rule.targetIp.trim()) {
    errors.targetIp = t("rulesPage.validation.dnsTargetIpRequired");
  } else if (!isValidIpAddress(rule.targetIp.trim())) {
    errors.targetIp = t("rulesPage.validation.dnsTargetIpInvalid");
  }
  return errors;
}

/* ── Validation helpers ───────────────────────────────────────────── */

export function getRewriteValidationErrors(rule: RewriteRule, t: TranslationFn): RuleFieldErrors {
  const errors: RuleFieldErrors = {};
  if (!rule.name.trim()) errors.name = t("rulesPage.validation.ruleNameRequired");
  if (!rule.match.urlPattern.trim())
    errors["match.urlPattern"] = t("rulesPage.validation.urlPatternRequired");
  if (rule.match.matchType === "regex" && rule.match.urlPattern.trim()) {
    try {
      new RegExp(rule.match.urlPattern.trim());
    } catch {
      errors["match.urlPattern"] = t("rulesPage.validation.regexPatternInvalid");
    }
  }

  if (rule.actions.length === 0) {
    errors.actions = t("rulesPage.rewrite.actionsRequired");
  }

  rule.actions.forEach((action, actionIndex) => {
    const key = (field: string) => `actions.${actionIndex}.payload.${field}`;
    if (action.rewriteType === "header") {
      if (!action.payload.headerName.trim())
        errors[key("headerName")] = t("rulesPage.validation.headerNameRequired");
      if (action.payload.operation === "set" && !(action.payload.value ?? "").trim())
        errors[key("value")] = t("rulesPage.validation.headerValueRequired");
    }
    if (action.rewriteType === "query") {
      if (!action.payload.paramName.trim())
        errors[key("paramName")] = t("rulesPage.validation.queryNameRequired");
      if (action.payload.operation === "set" && !(action.payload.value ?? "").trim())
        errors[key("value")] = t("rulesPage.validation.queryValueRequired");
    }
    if (action.rewriteType === "body") {
      const mode = action.payload.mode ?? "replace";
      if (mode === "replace" && !(action.payload.text ?? "").trim())
        errors[key("text")] = t("rulesPage.validation.bodyTextRequired");
      if (mode === "fields") {
        const fields = action.payload.fields ?? [];
        if (fields.length === 0) {
          errors[key("fields")] = t("rulesPage.validation.bodyFieldPathRequired");
        } else {
          fields.forEach((field, fieldIndex) => {
            if (!field.path.trim()) {
              errors[`${key("fields")}.${fieldIndex}.path`] = t(
                "rulesPage.validation.bodyFieldPathRequired",
              );
            }
          });
        }
        fields.forEach((field, fieldIndex) => {
          if (
            field.operation === "set" &&
            field.valueType !== "null" &&
            !(field.value ?? "").trim()
          ) {
            errors[`${key("fields")}.${fieldIndex}.value`] = t(
              "rulesPage.validation.bodyFieldValueRequired",
            );
          }
        });
      }
    }
    if (action.rewriteType === "redirect" && !action.payload.targetUrl.trim())
      errors[key("targetUrl")] = t("rulesPage.validation.redirectTargetRequired");
  });

  return errors;
}

export function getMapValidationErrors(rule: MapRule, t: TranslationFn): RuleFieldErrors {
  const errors: RuleFieldErrors = {};
  if (!rule.name.trim()) errors.name = t("rulesPage.validation.ruleNameRequired");
  if (!rule.sourcePattern.trim())
    errors.sourcePattern = t("rulesPage.validation.mapSourceRequired");
  if (!rule.targetValue.trim()) {
    errors.targetValue =
      rule.mode === "local"
        ? t("rulesPage.validation.localTargetRequired")
        : t("rulesPage.validation.remoteTargetRequired");
  } else if (rule.mode === "remote" && !isValidHttpUrl(rule.targetValue.trim())) {
    errors.targetValue = t("rulesPage.validation.remoteTargetInvalid");
  }
  return errors;
}

export function getScriptValidationErrors(rule: ScriptRule, t: TranslationFn): RuleFieldErrors {
  const errors: RuleFieldErrors = {};
  if (!rule.name.trim()) errors.name = t("rulesPage.validation.ruleNameRequired");
  if (!rule.match.urlPattern.trim())
    errors["match.urlPattern"] = t("rulesPage.validation.urlPatternRequired");
  if (!rule.sourceCode.trim()) errors.sourceCode = t("rulesPage.validation.scriptSourceRequired");
  return errors;
}

/**
 * Field-level validation result shared by the rule editors. Each validator
 * returns a map from a stable field key (e.g. `name`, `sourcePattern`,
 * `match.urlPattern`, `payload.fields.2.value`) to a localized message; this
 * helper adapts that map to MUI TextField props.
 */
export type RuleFieldErrors = Record<string, string>;

export function ruleFieldProps(
  errors: RuleFieldErrors,
  attempted: boolean,
  key: string,
): { error: boolean; helperText?: string } {
  const message = attempted ? errors[key] : undefined;
  return message ? { error: true, helperText: message } : { error: false };
}

export function hasRuleFieldErrors(errors: RuleFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/* ── Label / format helpers ───────────────────────────────────────── */

export function getRewriteTypeLabel(rewriteType: RewriteRuleType, t: TranslationFn) {
  switch (rewriteType) {
    case "header":
      return t("rulesPage.rewrite.types.header");
    case "query":
      return t("rulesPage.rewrite.types.query");
    case "body":
      return t("rulesPage.rewrite.types.body");
    case "redirect":
      return t("rulesPage.rewrite.types.redirect");
  }
}

export function formatRuleMatch(match: RuleMatch): string {
  const methods = match.methods.length === 0 ? "ALL" : match.methods.join(", ");
  return `${methods} • ${match.urlPattern || "*"}`;
}

export function wildcardMatch(pattern: string, candidate: string, matchType?: string): boolean {
  const normalized = pattern.trim();
  const mt = matchType || "contains";

  switch (mt) {
    case "exact":
      return candidate === normalized;
    case "regex": {
      try {
        return new RegExp(normalized).test(candidate);
      } catch {
        return false;
      }
    }
    case "wildcard": {
      if (!normalized || normalized === "*") return true;
      const parts = normalized.split("*").filter(Boolean);
      let cursor = 0;
      for (const [index, part] of parts.entries()) {
        const found = candidate.slice(cursor).indexOf(part);
        if (found < 0) return false;
        const absolute = cursor + found;
        if (index === 0 && !normalized.startsWith("*") && absolute !== 0) return false;
        cursor = absolute + part.length;
      }
      return normalized.endsWith("*") || candidate.endsWith(parts.at(-1) ?? "");
    }
    default: {
      if (!normalized || normalized === "*") return true;
      return candidate.includes(normalized);
    }
  }
}
