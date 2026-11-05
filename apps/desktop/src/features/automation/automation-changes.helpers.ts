import type {
  AutomationVerificationMode,
  AutomationVerificationRecord,
} from "@aiproxy/shared-types";

const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|secret|token|api[-_]?key/i;
const MAX_DISPLAY_VALUE_LENGTH = 320;

function hasSensitiveSibling(record: Record<string, unknown>): boolean {
  return ["headerName", "paramName", "path"].some(
    (key) => typeof record[key] === "string" && SENSITIVE_KEY_PATTERN.test(record[key] as string),
  );
}

function maskValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[…]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => maskValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Header/query/body-field payloads keep the sensitive name in a sibling
    // (`headerName`/`paramName`/`path`) and the value in `value`, so masking by
    // key name alone would render `Authorization: Bearer ...` in clear text.
    const maskSiblingValue = hasSensitiveSibling(record);
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) || (key === "value" && maskSiblingValue)
          ? "[REDACTED]"
          : maskValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > MAX_DISPLAY_VALUE_LENGTH) {
    return `${value.slice(0, MAX_DISPLAY_VALUE_LENGTH)}…`;
  }
  return value;
}

export function formatAutomationValue(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(maskValue(value), null, 2);
  } catch {
    return String(value);
  }
}

export function formatAutomationDate(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export const VERIFICATION_MODES: AutomationVerificationMode[] = ["offline", "proxy", "external"];

export function groupAutomationVerifications(
  records: AutomationVerificationRecord[],
): Record<AutomationVerificationMode, AutomationVerificationRecord[]> {
  return {
    offline: records.filter((record) => record.mode === "offline"),
    proxy: records.filter((record) => record.mode === "proxy"),
    external: records.filter((record) => record.mode === "external"),
  };
}
