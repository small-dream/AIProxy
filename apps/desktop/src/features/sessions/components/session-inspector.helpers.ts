import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};

export type SearchMatcher = (text: string) => Array<{ start: number; end: number }>;

export function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchMatcher(query: string, options: SearchOptions): SearchMatcher | null {
  const trimmed = query.trim();

  if (!trimmed) {
    return null;
  }

  if (options.useRegex) {
    try {
      const flags = options.caseSensitive ? "g" : "gi";
      const pattern = options.wholeWord ? `\\b(?:${trimmed})\\b` : trimmed;
      const regex = new RegExp(pattern, flags);
      return (text: string) => {
        const matches: Array<{ start: number; end: number }> = [];
        let match: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((match = regex.exec(text)) !== null) {
          if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          matches.push({ start: match.index, end: match.index + match[0].length });
        }
        return matches;
      };
    } catch {
      return null;
    }
  }

  if (options.wholeWord) {
    const escaped = escapeRegExp(trimmed);
    const flags = options.caseSensitive ? "g" : "gi";
    const regex = new RegExp(`\\b(?:${escaped})\\b`, flags);
    return (text: string) => {
      const matches: Array<{ start: number; end: number }> = [];
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length });
      }
      return matches;
    };
  }

  const searchStr = options.caseSensitive ? trimmed : trimmed.toLowerCase();

  return (text: string) => {
    const source = options.caseSensitive ? text : text.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    while (cursor < source.length) {
      const index = source.indexOf(searchStr, cursor);
      if (index === -1) break;
      matches.push({ start: index, end: index + searchStr.length });
      cursor = index + 1;
    }
    return matches;
  };
}

export type RequestInspectorTab =
  | "query"
  | "headers"
  | "body"
  | "form"
  | "raw";

export type ResponseInspectorTab =
  | "overview"
  | "headers"
  | "text"
  | "json"
  | "jsonText"
  | "raw";

export type JsonParseResult =
  | { status: "idle" }
  | { status: "tooLarge"; message: string }
  | { status: "error"; message: string }
  | { status: "success"; value: JsonValue };

export const DEFAULT_REQUEST_SPLIT_RATIO = 0.38;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const LARGE_JSON_SOFT_LIMIT = 256 * 1024;
const LARGE_JSON_HARD_LIMIT = 2 * 1024 * 1024;
const JSON_TEXT_INDENT_SPACES = 4;
const DEFAULT_JSON_PARSE_MESSAGES = enMessages.inspector.jsonParse;
const DEFAULT_COMMON_MESSAGES = enMessages.common;

export function buildCountTabLabel(label: string, count: number) {
  return count > 0 ? `${label} (${count})` : label;
}

export function buildRequestSubtitle(detail: SessionDetail | undefined) {
  return `${detail?.queryParams.length ?? 0} ${DEFAULT_COMMON_MESSAGES.labels.query.toLowerCase()} • ${detail?.requestHeaders.length ?? 0} ${DEFAULT_COMMON_MESSAGES.labels.headers.toLowerCase()} • ${describeBody(detail?.requestBody) ?? DEFAULT_COMMON_MESSAGES.tech.noBody}`;
}

export function buildResponseSubtitle(detail: SessionDetail | undefined, session: SessionSummary) {
  return `${session.statusCode} • ${detail?.responseHeaders.length ?? 0} ${DEFAULT_COMMON_MESSAGES.labels.headers.toLowerCase()} • ${describeBody(detail?.responseBody) ?? DEFAULT_COMMON_MESSAGES.tech.noBody}`;
}

export function getBodyText(body: BodyReference | undefined) {
  return body?.inlineText;
}

export function parseFormEntries(body: BodyReference | undefined): Array<[string, string]> {
  const text = getBodyText(body);
  const mimeType = body?.mimeType?.toLowerCase() ?? "";

  if (!text) {
    return [];
  }

  if (mimeType.includes("application/x-www-form-urlencoded")) {
    return Array.from(new URLSearchParams(text).entries());
  }

  if (mimeType.includes("multipart/form-data")) {
    return parseMultipartFormEntries(text);
  }

  return [];
}

export function parseJsonBody(
  body: BodyReference | undefined,
  bodyText: string | undefined,
  options?: {
    allowLargeTextFallback?: boolean;
    preferSoftWarning?: boolean;
    requestFallbackMessage?: string;
    responseErrorMessage?: string;
    tooLargeMessage?: string;
    truncatedMessage?: string;
  },
): JsonParseResult {
  if (!body || !bodyText || !looksLikeJson(body.mimeType, bodyText)) {
    return { status: "idle" };
  }

  if (body.sizeBytes > LARGE_JSON_HARD_LIMIT) {
    return {
      status: "tooLarge",
      message:
        options?.tooLargeMessage ??
        DEFAULT_JSON_PARSE_MESSAGES.tooLarge,
    };
  }

  if (body.truncated) {
    return {
      status: "error",
      message:
        options?.truncatedMessage ??
        DEFAULT_JSON_PARSE_MESSAGES.truncated,
    };
  }

  try {
    const parsed = JSON.parse(bodyText) as JsonValue;

    if (body.sizeBytes > LARGE_JSON_SOFT_LIMIT && options?.preferSoftWarning !== false) {
      return {
        status: "success",
        value: parsed,
      };
    }

    return {
      status: "success",
      value: parsed,
    };
  } catch {
    if (options?.allowLargeTextFallback) {
      return {
        status: "error",
        message: options.requestFallbackMessage ?? DEFAULT_JSON_PARSE_MESSAGES.requestFallback,
      };
    }

    return {
      status: "error",
      message: options?.responseErrorMessage ?? DEFAULT_JSON_PARSE_MESSAGES.responseError,
    };
  }
}

export function formatJsonText(value: JsonValue) {
  return JSON.stringify(value, null, JSON_TEXT_INDENT_SPACES);
}

export function normalizeSearch(searchQuery: string | undefined) {
  return searchQuery?.trim().toLocaleLowerCase() ?? "";
}

export function findNormalizedMatchIndex(text: string, searchQuery: string | undefined, fromIndex = 0) {
  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return -1;
  }

  return text.toLocaleLowerCase().indexOf(normalizedQuery, fromIndex);
}

export function describeBody(
  body: BodyReference | undefined,
  options?: {
    formatBytes?: (value: number) => string;
    truncatedPreviewLabel?: string;
    unknownMimeTypeLabel?: string;
  },
) {
  if (!body) {
    return undefined;
  }

  const mimeType = body.mimeType ?? options?.unknownMimeTypeLabel ?? DEFAULT_COMMON_MESSAGES.tech.unknownMimeType;
  const truncationSuffix = body.truncated ? ` (${options?.truncatedPreviewLabel ?? DEFAULT_COMMON_MESSAGES.tech.truncatedPreview})` : "";
  const sizeLabel = options?.formatBytes ? options.formatBytes(body.sizeBytes) : DEFAULT_COMMON_MESSAGES.tech.bytes.replace("{{value}}", String(body.sizeBytes));

  return `${mimeType} - ${sizeLabel}${truncationSuffix}`;
}

export function formatTiming(value: number | undefined, fallbackLabel: string = DEFAULT_COMMON_MESSAGES.states.notCaptured) {
  return value === undefined ? fallbackLabel : DEFAULT_COMMON_MESSAGES.tech.milliseconds.replace("{{value}}", String(value));
}

export function getStatusColor(statusCode: number): "default" | "error" | "info" | "success" | "warning" {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warning";
  }

  if (statusCode >= 300) {
    return "info";
  }

  if (statusCode >= 200) {
    return "success";
  }

  return "default";
}

export function getMethodColor(method: string): "default" | "error" | "info" | "primary" | "secondary" | "success" | "warning" {
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return "success";
  }

  if (normalizedMethod === "POST") {
    return "primary";
  }

  if (normalizedMethod === "PUT") {
    return "warning";
  }

  if (normalizedMethod === "PATCH") {
    return "secondary";
  }

  if (normalizedMethod === "DELETE") {
    return "error";
  }

  if (normalizedMethod === "OPTIONS") {
    return "info";
  }

  return "default";
}

const REQUEST_OPERATION_QUERY_KEYS = [
  "_method",
  "method",
  "action",
  "operation",
  "op",
  "methodName",
  "operationName",
] as const;

const REQUEST_OPERATION_PATH_KEYS = new Set([
  "method",
  "action",
  "operation",
  "op",
  "m",
  "rpc",
]);

export function getRequestOperationLabel(detail: SessionDetail | undefined, session: SessionSummary): string | undefined {
  const queryParamValue = getRequestOperationFromQuery(detail?.queryParams);

  if (queryParamValue) {
    return queryParamValue;
  }

  const pathSegments = getRequestPathSegments(session);
  const keyedPathValue = getRequestOperationFromKeyedPath(pathSegments);

  if (keyedPathValue) {
    return keyedPathValue;
  }

  return [...pathSegments].reverse().find(isLikelyOperationSegment);
}

export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSubtreeMatches(name: string | undefined, value: JsonValue, searchQuery: string): boolean {
  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return true;
  }

  if (name && findNormalizedMatchIndex(name, normalizedQuery) !== -1) {
    return true;
  }

  if (typeof value === "string") {
    return findNormalizedMatchIndex(value, normalizedQuery) !== -1;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return findNormalizedMatchIndex(String(value), normalizedQuery) !== -1;
  }

  if (Array.isArray(value)) {
    return value.some((child, index) => jsonSubtreeMatches(String(index), child, normalizedQuery));
  }

  return Object.entries(value).some(([childName, childValue]) => jsonSubtreeMatches(childName, childValue, normalizedQuery));
}

export function formatJsonPrimitive(value: JsonValue): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }

  return String(value);
}

function getRequestOperationFromQuery(queryParams: SessionDetail["queryParams"] | undefined): string | undefined {
  if (!queryParams?.length) {
    return undefined;
  }

  for (const key of REQUEST_OPERATION_QUERY_KEYS) {
    const entry = queryParams.find((queryParam) => queryParam.name.toLowerCase() === key.toLowerCase());
    const normalizedValue = normalizeOperationValue(entry?.value);

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  const fuzzyEntry = queryParams.find((queryParam) => {
    const normalizedName = queryParam.name.toLowerCase();
    return normalizedName.endsWith("method") || normalizedName.endsWith("action") || normalizedName.endsWith("operation");
  });

  return normalizeOperationValue(fuzzyEntry?.value);
}

function getRequestPathSegments(session: SessionSummary): string[] {
  try {
    return new URL(session.url)
      .pathname
      .split("/")
      .map(decodeURIComponent)
      .map((segment) => segment.trim())
      .filter(Boolean);
  } catch {
    return (session.path.split("?")[0] ?? session.path)
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
  }
}

function getRequestOperationFromKeyedPath(pathSegments: string[]): string | undefined {
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const currentSegment = pathSegments[index];
    const nextSegment = pathSegments[index + 1];
    const nextNextSegment = pathSegments[index + 2];

    if (!currentSegment || !nextSegment || !REQUEST_OPERATION_PATH_KEYS.has(currentSegment.toLowerCase())) {
      continue;
    }

    if (REQUEST_OPERATION_PATH_KEYS.has(nextSegment.toLowerCase())) {
      const nestedNormalizedValue = normalizeOperationValue(nextNextSegment);

      if (nestedNormalizedValue) {
        return nestedNormalizedValue;
      }
    }

    const normalizedValue = normalizeOperationValue(nextSegment);

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return undefined;
}

function isLikelyOperationSegment(segment: string): boolean {
  const normalizedSegment = normalizeOperationValue(segment);

  if (!normalizedSegment) {
    return false;
  }

  if (/^v\d+$/i.test(normalizedSegment) || /^\d+$/.test(normalizedSegment)) {
    return false;
  }

  if (["api", "rest", "rpc", "gateway", "service", "services"].includes(normalizedSegment.toLowerCase())) {
    return false;
  }

  return /[.:_]/.test(normalizedSegment);
}

function normalizeOperationValue(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue ? normalizedValue : undefined;
}

export function getJsonValueType(
  value: JsonValue,
  labels?: {
    array: (count: number) => string;
    boolean: string;
    integer: string;
    null: string;
    number: string;
    object: (count: number) => string;
    string: string;
    unknown: string;
  },
): string {
  if (Array.isArray(value)) {
    return labels?.array ? labels.array(value.length) : `Array[${value.length}]`;
  }

  if (isJsonObject(value)) {
    return labels?.object ? labels.object(Object.keys(value).length) : `Object[${Object.keys(value).length}]`;
  }

  if (value === null) {
    return labels?.null ?? "Null";
  }

  if (typeof value === "string") {
    return labels?.string ?? "String";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? (labels?.integer ?? "Integer") : (labels?.number ?? "Number");
  }

  if (typeof value === "boolean") {
    return labels?.boolean ?? "Boolean";
  }

  return labels?.unknown ?? "Unknown";
}

function looksLikeJson(mimeType: string | undefined, bodyText: string) {
  const normalizedMimeType = mimeType?.toLowerCase() ?? "";
  const trimmedText = bodyText.trim();

  return (
    normalizedMimeType.includes("application/json") ||
    normalizedMimeType.includes("+json") ||
    trimmedText.startsWith("{") ||
    trimmedText.startsWith("[")
  );
}

function parseMultipartFormEntries(text: string): Array<[string, string]> {
  const lines = text.split(/\r?\n/);
  const boundary = lines.find((line) => line.startsWith("--"));

  if (!boundary) {
    return [];
  }

  return text
    .split(boundary)
    .map((part) => part.trim())
    .filter((part) => part && part !== "--")
    .map((part) => {
      const dispositionMatch = part.match(/name="([^"]+)"/i);
      const value = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/\r?\n--$/, "").trim();

      return [dispositionMatch?.[1] ?? "field", value || "(empty)"] as [string, string];
    });
}
