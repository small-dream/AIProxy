import type { FormFileEntry, HeaderEntry, MultipartEntry } from "@aiproxy/shared-types";

import { substituteVariables } from "@/features/environments/use-environments";

import { RAW_LANGUAGE_CONTENT_TYPE, URLENCODED_CONTENT_TYPE } from "./compose-editor.store";
import type { BodyType, RawLanguage } from "./types";

/** Append a Content-Type header if one is not already present. */
export function ensureContentType(headers: HeaderEntry[], contentType: string): HeaderEntry[] {
  if (headers.some((h) => h.name.toLowerCase() === "content-type")) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}

export type ComposedRequestEncodingInput = {
  body: string;
  bodyType: BodyType;
  formDataEntries: HeaderEntry[];
  formFiles?: FormFileEntry[];
  headers: HeaderEntry[];
  rawLanguage: RawLanguage;
  url: string;
  urlEncodedEntries: HeaderEntry[];
};

export type ComposedRequestEncoding = {
  headers: HeaderEntry[];
  multipartEntries?: MultipartEntry[];
  textBody?: string;
  url: string;
};

/**
 * Shared request-body encoder for the Compose and Collections editors.
 * Variable substitution is inline (url/body/header name+value/formData/
 * urlEncoded name+value); file paths are passed through untouched (D1).
 *
 * Multipart form-data is emitted as structured `multipartEntries`; the Rust
 * send path builds the raw bytes (D1).
 */
export function encodeComposedRequest(
  input: ComposedRequestEncodingInput,
  vars?: Map<string, string>,
): ComposedRequestEncoding {
  const substitute = (value: string) => (vars ? substituteVariables(value, vars) : value);
  const url = substitute(input.url);
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
      const textEntries: MultipartEntry[] = input.formDataEntries
        .filter((entry) => substitute(entry.name).trim())
        .map((entry) => ({
          kind: "text",
          name: substitute(entry.name),
          value: substitute(entry.value),
        }));
      const fileEntries: MultipartEntry[] = (input.formFiles ?? [])
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
    url,
  };
}
