import type { HeaderEntry } from "@aiproxy/shared-types";

import { substituteVariables } from "@/features/environments/use-environments";

import {
  buildMultipartBody,
  FORMDATA_CONTENT_TYPE,
  RAW_LANGUAGE_CONTENT_TYPE,
  URLENCODED_CONTENT_TYPE,
} from "./compose-editor.store";
import type { BodyType, RawLanguage } from "./types";

/** Append a Content-Type header if one is not already present. */
export function ensureContentType(headers: HeaderEntry[], contentType: string): HeaderEntry[] {
  if (headers.some((h) => h.name.toLowerCase() === "content-type")) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}

/** A text multipart part (used until C3 wires real file bytes). */
export type MultipartTextEntry = {
  kind: "text";
  name: string;
  value: string;
};

/** A file multipart part: the renderer never touches file contents (D1). */
export type MultipartFileEntry = {
  kind: "file";
  name: string;
  fileName: string;
  filePath: string;
  contentType?: string;
};

export type MultipartEntry = MultipartTextEntry | MultipartFileEntry;

export type FormFileEntry = {
  name: string;
  fileName: string;
  filePath: string;
  contentType?: string;
};

export type ComposedRequestEncodingInput = {
  body: string;
  bodyType: BodyType;
  formDataEntries: HeaderEntry[];
  formFiles?: FormFileEntry[];
  headers: HeaderEntry[];
  rawLanguage: RawLanguage;
  urlEncodedEntries: HeaderEntry[];
};

export type ComposedRequestEncoding = {
  headers: HeaderEntry[];
  multipartEntries?: MultipartEntry[];
  textBody?: string;
};

/**
 * Shared request-body encoder for the Compose and Collections editors.
 * Variable substitution is inline (url/body/header name+value/formData/
 * urlEncoded name+value); file paths are passed through untouched (D1).
 *
 * Phase 3.1 keeps multipart as plain text for behavior parity; the returned
 * `multipartEntries` drives the Rust byte builder in C3.
 */
export function encodeComposedRequest(
  input: ComposedRequestEncodingInput,
  vars?: Map<string, string>,
): ComposedRequestEncoding {
  const substitute = (value: string) => (vars ? substituteVariables(value, vars) : value);
  let finalHeaders = input.headers.map((header) => ({
    name: substitute(header.name),
    value: substitute(header.value),
  }));
  let textBody: string | undefined;
  let multipartEntries: MultipartEntry[] | undefined;

  switch (input.bodyType) {
    case "none":
      break;
    case "formdata": {
      const textEntries: MultipartTextEntry[] = input.formDataEntries
        .filter((entry) => substitute(entry.name).trim())
        .map((entry) => ({
          kind: "text",
          name: substitute(entry.name),
          value: substitute(entry.value),
        }));
      const fileEntries: MultipartFileEntry[] = (input.formFiles ?? [])
        .filter((entry) => substitute(entry.name).trim())
        .map((entry) => ({
          kind: "file",
          name: substitute(entry.name),
          fileName: entry.fileName,
          filePath: entry.filePath,
          ...(entry.contentType ? { contentType: entry.contentType } : {}),
        }));
      const entries = [...textEntries, ...fileEntries];
      if (entries.length > 0) {
        multipartEntries = entries;
        // 3.1 parity: plain-text encoding until C3 delegates to the Rust
        // multipart byte builder.
        const boundary = `----AIProxyBoundary${Date.now().toString(16)}`;
        textBody = buildMultipartBody(
          entries.map((entry) =>
            entry.kind === "text"
              ? { name: entry.name, value: entry.value }
              : { name: entry.name, value: `@${entry.filePath}` },
          ),
          boundary,
        );
        finalHeaders = ensureContentType(
          finalHeaders,
          `${FORMDATA_CONTENT_TYPE}; boundary=${boundary}`,
        );
      }
      break;
    }
    case "urlencoded": {
      const active = input.urlEncodedEntries
        .filter((entry) => substitute(entry.name).trim())
        .map((entry) => ({
          name: substitute(entry.name),
          value: substitute(entry.value),
        }));
      if (active.length > 0) {
        textBody = active
          .map((entry) => `${encodeURIComponent(entry.name)}=${encodeURIComponent(entry.value)}`)
          .join("&");
        finalHeaders = ensureContentType(finalHeaders, URLENCODED_CONTENT_TYPE);
      }
      break;
    }
    case "raw": {
      const substitutedBody = substitute(input.body);
      if (substitutedBody.trim()) {
        textBody = substitutedBody;
        finalHeaders = ensureContentType(
          finalHeaders,
          RAW_LANGUAGE_CONTENT_TYPE[input.rawLanguage],
        );
      }
      break;
    }
  }

  return {
    headers: finalHeaders,
    ...(multipartEntries !== undefined ? { multipartEntries } : {}),
    ...(textBody !== undefined ? { textBody } : {}),
  };
}
