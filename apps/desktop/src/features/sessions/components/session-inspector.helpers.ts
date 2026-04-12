import type { BodyReference, SessionDetail, SessionSummary } from "@pharles/shared-types";

export type RequestInspectorTab =
  | "overview"
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
  | { status: "success"; value: JsonValue; prettyText: string };

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

export function buildCountTabLabel(label: string, count: number) {
  return count > 0 ? `${label} (${count})` : label;
}

export function buildRequestSubtitle(detail: SessionDetail | undefined) {
  return `${detail?.queryParams.length ?? 0} query • ${detail?.requestHeaders.length ?? 0} headers • ${describeBody(detail?.requestBody) ?? "No body"}`;
}

export function buildResponseSubtitle(detail: SessionDetail | undefined, session: SessionSummary) {
  return `${session.statusCode} • ${detail?.responseHeaders.length ?? 0} headers • ${describeBody(detail?.responseBody) ?? "No body"}`;
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
  },
): JsonParseResult {
  if (!body || !bodyText || !looksLikeJson(body.mimeType, bodyText)) {
    return { status: "idle" };
  }

  if (body.sizeBytes > LARGE_JSON_HARD_LIMIT) {
    return {
      status: "tooLarge",
      message:
        "JSON body is too large for tree rendering right now. Use JSON Text or Raw to inspect the payload.",
    };
  }

  try {
    const parsed = JSON.parse(bodyText) as JsonValue;

    if (body.sizeBytes > LARGE_JSON_SOFT_LIMIT && options?.preferSoftWarning !== false) {
      return {
        prettyText: JSON.stringify(parsed, null, 2),
        status: "success",
        value: parsed,
      };
    }

    return {
      prettyText: JSON.stringify(parsed, null, 2),
      status: "success",
      value: parsed,
    };
  } catch {
    if (options?.allowLargeTextFallback) {
      return {
        status: "error",
        message: "Unable to parse this body as JSON. Showing the original text instead.",
      };
    }

    return {
      status: "error",
      message: "Unable to parse the response body as JSON.",
    };
  }
}

export function normalizeSearch(searchQuery: string | undefined) {
  return searchQuery?.trim().toLowerCase() ?? "";
}

export function describeBody(body: BodyReference | undefined) {
  if (!body) {
    return undefined;
  }

  const mimeType = body.mimeType ?? "unknown";
  const truncationSuffix = body.truncated ? " (truncated preview)" : "";

  return `${mimeType} - ${body.sizeBytes} bytes${truncationSuffix}`;
}

export function formatTiming(value: number | undefined) {
  return value === undefined ? "Not captured" : `${value} ms`;
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

export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSubtreeMatches(name: string | undefined, value: JsonValue, searchQuery: string): boolean {
  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return true;
  }

  if (name?.toLowerCase().includes(normalizedQuery)) {
    return true;
  }

  if (typeof value === "string") {
    return value.toLowerCase().includes(normalizedQuery);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value).toLowerCase().includes(normalizedQuery);
  }

  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => jsonSubtreeMatches(undefined, child, normalizedQuery));
}

export function formatJsonPrimitive(value: JsonValue): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }

  return String(value);
}

export function getJsonValueType(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `Array[${value.length}]`;
  }

  if (isJsonObject(value)) {
    return `Object[${Object.keys(value).length}]`;
  }

  if (value === null) {
    return "Null";
  }

  if (typeof value === "string") {
    return "String";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? "Integer" : "Number";
  }

  if (typeof value === "boolean") {
    return "Boolean";
  }

  return "Unknown";
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
