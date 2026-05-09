import type { BodyReference, HeaderEntry, SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import type { BodyType, RawLanguage } from "@/features/compose/compose-editor.store";
import { parseFormEntries } from "@/features/sessions/components/session-inspector.helpers";
import { getBodyText } from "@/features/sessions/session-export.helpers";

export type ComposeLoadFromSessionInput = {
  body?: string;
  bodyType?: BodyType;
  formDataEntries?: HeaderEntry[];
  headers: HeaderEntry[];
  method: string;
  rawLanguage?: RawLanguage;
  url: string;
  urlEncodedEntries?: HeaderEntry[];
};

export function buildComposeLoadInput(
  session: SessionSummary,
  detail: SessionDetail | undefined,
): ComposeLoadFromSessionInput {
  const headers = detail?.requestHeaders ?? [];
  const bodyText = getBodyText(detail?.requestBody);
  const bodyConfig = inferComposeBodyConfig(detail?.requestBody, headers, bodyText);

  return {
    method: session.method,
    url: session.url,
    headers,
    ...(bodyText ? { body: bodyText } : {}),
    ...bodyConfig,
  };
}

function inferComposeBodyConfig(
  body: BodyReference | undefined,
  headers: HeaderEntry[],
  bodyText: string,
): Pick<ComposeLoadFromSessionInput, "bodyType" | "formDataEntries" | "rawLanguage" | "urlEncodedEntries"> {
  if (!bodyText) {
    return { bodyType: "none", rawLanguage: "json", formDataEntries: [], urlEncodedEntries: [] };
  }

  const contentType = getContentType(body, headers);

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const urlEncodedEntries = parseUrlEncodedEntries(bodyText);

    if (urlEncodedEntries.length > 0) {
      return { bodyType: "urlencoded", rawLanguage: "json", formDataEntries: [], urlEncodedEntries };
    }
  }

  if (contentType.includes("multipart/form-data")) {
    const formDataEntries = parseFormEntries(body)
      .filter((entry) => entry.kind === "field")
      .map((entry) => ({ name: entry.name, value: entry.value }));

    if (formDataEntries.length > 0) {
      return { bodyType: "formdata", rawLanguage: "json", formDataEntries, urlEncodedEntries: [] };
    }
  }

  return {
    bodyType: "raw",
    rawLanguage: inferRawLanguage(contentType),
    formDataEntries: [],
    urlEncodedEntries: [],
  };
}

function parseUrlEncodedEntries(bodyText: string): HeaderEntry[] {
  return Array.from(new URLSearchParams(bodyText).entries()).map(([name, value]) => ({ name, value }));
}

function getContentType(body: BodyReference | undefined, headers: HeaderEntry[]): string {
  const bodyMimeType = body?.mimeType?.toLowerCase();

  if (bodyMimeType) {
    return bodyMimeType;
  }

  return headers.find((header) => header.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
}

function inferRawLanguage(contentType: string): RawLanguage {
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return "json";
  }

  if (contentType.includes("xml")) {
    return "xml";
  }

  if (contentType.includes("html")) {
    return "html";
  }

  if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
    return "javascript";
  }

  return "text";
}
