import type { BodyReference, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";
import { isWebSocketSessionProtocol } from "@/features/sessions/session-protocol.helpers";

export function isWebSocketSession(session: SessionSummary): boolean {
  return session.statusCode === 101 || isWebSocketSessionProtocol(session);
}

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
  | "automation"
  | "headers"
  | "messages"
  | "text"
  | "json"
  | "jsonText"
  | "raw";

export type JsonParseResult =
  | { status: "idle" }
  | { status: "tooLarge"; message: string }
  | { status: "error"; message: string }
  | { status: "success"; value: JsonValue };

export type RequestFormEntry =
  | {
      kind: "field";
      name: string;
      value: string;
      contentType?: string;
    }
  | {
      kind: "file";
      name: string;
      filename: string;
      sizeBytes: number;
      contentType?: string;
    };

export const INSPECTOR_SPLIT_MIN = 0.15;
export const INSPECTOR_SPLIT_MAX = 0.85;
export const DEFAULT_REQUEST_SPLIT_RATIO = 0.38;

export function clampInspectorSplitRatio(ratio: number): number {
  return Math.min(INSPECTOR_SPLIT_MAX, Math.max(INSPECTOR_SPLIT_MIN, ratio));
}

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

export function getRawMessageText(
  rawText: string | undefined,
  rawHead: string | undefined,
  body: BodyReference | undefined,
) {
  if (rawText !== undefined) {
    return rawText;
  }

  if (!rawHead) {
    return undefined;
  }

  if (!body) {
    return rawHead;
  }

  if (body.inlineText !== undefined) {
    return `${rawHead}${body.inlineText}`;
  }

  return undefined;
}

export function getBodyCodeLanguage(
  body: BodyReference | undefined,
  bodyText: string | undefined,
): "json" | "plain" {
  if (!body || !bodyText) {
    return "plain";
  }

  return looksLikeJson(body.mimeType, bodyText) ? "json" : "plain";
}

export function parseFormEntries(body: BodyReference | undefined): RequestFormEntry[] {
  if (!body) {
    return [];
  }

  const mimeType = body?.mimeType?.toLowerCase() ?? "";

  if (mimeType.includes("application/x-www-form-urlencoded")) {
    const text = getBodyText(body);

    if (!text) {
      return [];
    }

    return Array.from(new URLSearchParams(text).entries()).map(([name, value]) => ({
      contentType: "text/plain; charset=utf-8",
      kind: "field",
      name,
      value,
    }));
  }

  if (mimeType.includes("multipart/form-data")) {
    return parseMultipartFormEntries(body);
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
  if (value === undefined) {
    return fallbackLabel;
  }

  if (value === 0) {
    return DEFAULT_COMMON_MESSAGES.tech.lessThanMillisecond;
  }

  return DEFAULT_COMMON_MESSAGES.tech.milliseconds.replace("{{value}}", String(value));
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
    return value;
  }

  return String(value);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function serializeJsonNode(value: JsonValue): string {
  if (Array.isArray(value) || isJsonObject(value)) {
    return formatJsonText(value);
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

export function getJsonChildren(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [`[${index}]`, entry] as [string, JsonValue]);
  }

  if (isJsonObject(value)) {
    return Object.entries(value);
  }

  return [];
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
    return labels?.array ? labels.array(value.length) : `Array [${value.length}]`;
  }

  if (isJsonObject(value)) {
    return labels?.object ? labels.object(Object.keys(value).length) : `Object [${Object.keys(value).length}]`;
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

const DEFAULT_MULTIPART_FIELD_CONTENT_TYPE = "text/plain; charset=utf-8";
const CRLF_BYTES = new Uint8Array([13, 10]);
const DOUBLE_CRLF_BYTES = new Uint8Array([13, 10, 13, 10]);
const DOUBLE_LF_BYTES = new Uint8Array([10, 10]);
const DASH_DASH_BYTES = new Uint8Array([45, 45]);
const textEncoder = new TextEncoder();

function parseMultipartFormEntries(body: BodyReference): RequestFormEntry[] {
  const bytes = getBodyBytes(body);

  if (!bytes || bytes.length === 0) {
    return [];
  }

  const boundaryLine = readMultipartBoundaryLine(bytes);

  if (!boundaryLine) {
    return [];
  }

  const boundaryBytes = textEncoder.encode(boundaryLine);
  const entries: RequestFormEntry[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const boundaryStart = findSequence(bytes, boundaryBytes, cursor);

    if (boundaryStart === -1) {
      break;
    }

    let partStart = boundaryStart + boundaryBytes.length;

    if (matchesAt(bytes, DASH_DASH_BYTES, partStart)) {
      break;
    }

    if (matchesAt(bytes, CRLF_BYTES, partStart)) {
      partStart += CRLF_BYTES.length;
    } else if (bytes[partStart] === 10) {
      partStart += 1;
    }

    const headerSeparator = findHeaderSeparator(bytes, partStart);

    if (!headerSeparator) {
      break;
    }

    const headersText = decodeMultipartText(bytes.slice(partStart, headerSeparator.index));
    const nextBoundary = findNextMultipartBoundary(bytes, boundaryBytes, headerSeparator.index + headerSeparator.length);

    if (!nextBoundary) {
      break;
    }

    const contentBytes = bytes.slice(headerSeparator.index + headerSeparator.length, nextBoundary.contentEnd);
    const parsedEntry = buildMultipartFormEntry(headersText, contentBytes);

    if (parsedEntry) {
      entries.push(parsedEntry);
    }

    cursor = nextBoundary.boundaryIndex;
  }

  return entries;
}

function getBodyBytes(body: BodyReference): Uint8Array | undefined {
  if (body.base64Text) {
    try {
      const decoded = atob(body.base64Text);
      return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    } catch {
      return undefined;
    }
  }

  if (body.inlineText !== undefined) {
    return textEncoder.encode(body.inlineText);
  }

  return undefined;
}

function readMultipartBoundaryLine(bytes: Uint8Array): string | undefined {
  const lineEndIndex = bytes.indexOf(10);
  const boundarySlice = lineEndIndex === -1 ? bytes : bytes.slice(0, lineEndIndex);
  const normalizedSlice = boundarySlice[boundarySlice.length - 1] === 13
    ? boundarySlice.slice(0, -1)
    : boundarySlice;
  const boundary = decodeMultipartText(normalizedSlice);

  return boundary.startsWith("--") ? boundary : undefined;
}

function findHeaderSeparator(bytes: Uint8Array, start: number): { index: number; length: number } | undefined {
  const crlfIndex = findSequence(bytes, DOUBLE_CRLF_BYTES, start);

  if (crlfIndex !== -1) {
    return { index: crlfIndex, length: DOUBLE_CRLF_BYTES.length };
  }

  const lfIndex = findSequence(bytes, DOUBLE_LF_BYTES, start);

  if (lfIndex !== -1) {
    return { index: lfIndex, length: DOUBLE_LF_BYTES.length };
  }

  return undefined;
}

function findNextMultipartBoundary(
  bytes: Uint8Array,
  boundaryBytes: Uint8Array,
  start: number,
): { boundaryIndex: number; contentEnd: number } | undefined {
  const crlfBoundary = concatBytes(CRLF_BYTES, boundaryBytes);
  const crlfBoundaryIndex = findSequence(bytes, crlfBoundary, start);

  if (crlfBoundaryIndex !== -1) {
    return {
      boundaryIndex: crlfBoundaryIndex + CRLF_BYTES.length,
      contentEnd: crlfBoundaryIndex,
    };
  }

  const boundaryIndex = findSequence(bytes, boundaryBytes, start);

  if (boundaryIndex !== -1) {
    return {
      boundaryIndex,
      contentEnd: boundaryIndex,
    };
  }

  return undefined;
}

function buildMultipartFormEntry(headersText: string, contentBytes: Uint8Array): RequestFormEntry | undefined {
  const headerMap = parseMultipartHeaders(headersText);
  const disposition = headerMap.get("content-disposition");

  if (!disposition) {
    return undefined;
  }

  const name = extractDispositionParameter(disposition, "name") ?? "field";
  const filename = extractDispositionParameter(disposition, "filename");
  const contentType = headerMap.get("content-type")?.trim();

  if (filename !== undefined) {
    return {
      filename,
      kind: "file",
      name,
      sizeBytes: contentBytes.length,
      ...(contentType ? { contentType } : {}),
    };
  }

  return {
    contentType: contentType ?? DEFAULT_MULTIPART_FIELD_CONTENT_TYPE,
    kind: "field",
    name,
    value: decodeMultipartText(contentBytes, extractCharset(contentType)) || "(empty)",
  };
}

function parseMultipartHeaders(headersText: string): Map<string, string> {
  const headerMap = new Map<string, string>();

  for (const line of headersText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (name) {
      headerMap.set(name, value);
    }
  }

  return headerMap;
}

function extractDispositionParameter(disposition: string, key: string): string | undefined {
  const quotedMatch = disposition.match(new RegExp(`${key}="([^"]*)"`, "i"));

  if (quotedMatch?.[1] !== undefined) {
    return quotedMatch[1];
  }

  const bareMatch = disposition.match(new RegExp(`${key}=([^;]+)`, "i"));

  return bareMatch?.[1]?.trim();
}

function extractCharset(contentType: string | undefined): string | undefined {
  if (!contentType) {
    return undefined;
  }

  const match = contentType.match(/charset=([^;]+)/i);

  return match?.[1]?.trim();
}

function decodeMultipartText(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function findSequence(bytes: Uint8Array, sequence: Uint8Array, start: number): number {
  if (sequence.length === 0 || start >= bytes.length) {
    return -1;
  }

  const maxIndex = bytes.length - sequence.length;

  for (let index = Math.max(0, start); index <= maxIndex; index += 1) {
    let matched = true;

    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return index;
    }
  }

  return -1;
}

function matchesAt(bytes: Uint8Array, sequence: Uint8Array, start: number): boolean {
  if (start < 0 || start + sequence.length > bytes.length) {
    return false;
  }

  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (bytes[start + offset] !== sequence[offset]) {
      return false;
    }
  }

  return true;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);

  merged.set(left, 0);
  merged.set(right, left.length);

  return merged;
}
