import { coerceAppError } from "./common";
import {
  isBreakpointRule,
  isDnsMappingRule,
  isMapRule,
  isRewriteRule,
  isScriptRule,
  type BreakpointRule,
  type DnsMappingRule,
  type MapRule,
  type RewriteRule,
  type ScriptRule,
} from "./rules";
import {
  isThrottleProfile,
  isThrottleRule,
  type ThrottleProfile,
  type ThrottleRule,
} from "./throttling";

export const RULES_EXPORT_FORMAT = "aiproxy.rules" as const;
export const RULES_EXPORT_VERSION = 1 as const;

/**
 * Error code thrown by `parseRulesExportFile` when the file IS an
 * `aiproxy.rules` export but its version is not one this build understands.
 * Import UIs branch on this code to show version-specific guidance instead of
 * the generic invalid-file message (review N-3: the old throw collapsed every
 * failure into UNKNOWN_ERROR, making that distinction unreachable).
 */
export const UNSUPPORTED_RULES_VERSION_CODE = "UNSUPPORTED_RULES_VERSION";

/**
 * Single-file rules export (R2). `throttleProfiles` must travel with the
 * throttle rules, otherwise the rules reference missing profiles and are dead
 * configuration.
 */
export type RulesExportFile = {
  exportedAt: string;
  format: typeof RULES_EXPORT_FORMAT;
  rules: {
    breakpoint: BreakpointRule[];
    dns: DnsMappingRule[];
    map: MapRule[];
    rewrite: RewriteRule[];
    script: ScriptRule[];
    throttle: ThrottleRule[];
    throttleProfiles: ThrottleProfile[];
  };
  version: typeof RULES_EXPORT_VERSION;
};

function isRulesExportFile(value: unknown): value is RulesExportFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RulesExportFile>;
  const rules = candidate.rules as Partial<RulesExportFile["rules"]> | undefined;

  return (
    candidate.format === RULES_EXPORT_FORMAT &&
    candidate.version === RULES_EXPORT_VERSION &&
    typeof candidate.exportedAt === "string" &&
    typeof rules === "object" &&
    rules !== null &&
    Array.isArray(rules.rewrite) &&
    rules.rewrite.every(isRewriteRule) &&
    Array.isArray(rules.map) &&
    rules.map.every(isMapRule) &&
    Array.isArray(rules.dns) &&
    rules.dns.every(isDnsMappingRule) &&
    Array.isArray(rules.script) &&
    rules.script.every(isScriptRule) &&
    Array.isArray(rules.breakpoint) &&
    rules.breakpoint.every(isBreakpointRule) &&
    Array.isArray(rules.throttle) &&
    rules.throttle.every(isThrottleRule) &&
    Array.isArray(rules.throttleProfiles) &&
    rules.throttleProfiles.every(isThrottleProfile)
  );
}

export function parseRulesExportFile(value: unknown): RulesExportFile {
  // Recognized format + wrong version: a structured, code-bearing error so
  // callers can branch on UNSUPPORTED_RULES_VERSION_CODE (review N-3). This
  // runs BEFORE the shape check, which would otherwise collapse it into a
  // generic UNKNOWN_ERROR whose message never mentions "unsupported".
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<RulesExportFile>;
    if (
      candidate.format === RULES_EXPORT_FORMAT &&
      typeof candidate.version === "number" &&
      candidate.version !== RULES_EXPORT_VERSION
    ) {
      throw {
        code: UNSUPPORTED_RULES_VERSION_CODE,
        message:
          `Rules export version ${candidate.version} is not supported; ` +
          `this build supports version ${RULES_EXPORT_VERSION}.`,
        details: { version: candidate.version },
      };
    }
  }
  if (!isRulesExportFile(value)) {
    throw coerceAppError(value);
  }
  return value;
}
