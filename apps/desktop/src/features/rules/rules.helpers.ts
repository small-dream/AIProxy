import type {
  BreakpointRule,
  BreakpointStage,
  DnsMappingRule,
  MapRule,
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
      return {
        ...base,
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
        ...base,
        rewriteType,
        payload: { preservePath: true, preserveQuery: true, targetUrl: "" },
      };
    case "header":
    default:
      return {
        ...base,
        rewriteType: "header",
        payload: { headerName: "", operation: "set", target: "request", value: "" },
      };
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

  if (rule.rewriteType === "header") {
    if (!rule.payload.headerName.trim())
      errors["payload.headerName"] = t("rulesPage.validation.headerNameRequired");
    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim())
      errors["payload.value"] = t("rulesPage.validation.headerValueRequired");
  }
  if (rule.rewriteType === "query") {
    if (!rule.payload.paramName.trim())
      errors["payload.paramName"] = t("rulesPage.validation.queryNameRequired");
    if (rule.payload.operation === "set" && !(rule.payload.value ?? "").trim())
      errors["payload.value"] = t("rulesPage.validation.queryValueRequired");
  }
  if (rule.rewriteType === "body") {
    const mode = rule.payload.mode ?? "replace";
    if (mode === "replace" && !(rule.payload.text ?? "").trim())
      errors["payload.text"] = t("rulesPage.validation.bodyTextRequired");
    if (mode === "fields") {
      const fields = rule.payload.fields ?? [];
      if (fields.length === 0 || fields.some((field) => !field.path.trim())) {
        if (fields.length === 0) {
          errors["payload.fields"] = t("rulesPage.validation.bodyFieldPathRequired");
        } else {
          fields.forEach((field, index) => {
            if (!field.path.trim()) {
              errors[`payload.fields.${index}.path`] = t(
                "rulesPage.validation.bodyFieldPathRequired",
              );
            }
          });
        }
      }
      fields.forEach((field, index) => {
        if (
          field.operation === "set" &&
          field.valueType !== "null" &&
          !(field.value ?? "").trim()
        ) {
          errors[`payload.fields.${index}.value`] = t(
            "rulesPage.validation.bodyFieldValueRequired",
          );
        }
      });
    }
  }
  if (rule.rewriteType === "redirect" && !rule.payload.targetUrl.trim())
    errors["payload.targetUrl"] = t("rulesPage.validation.redirectTargetRequired");

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
