import {
  type BodyReference,
  type HeaderEntry,
  isHeaderEntry,
  type SessionDetail,
} from "./sessions";

export type ComposedRequestInput = {
  workspaceId: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
  /** Structured multipart parts for the Rust byte builder (C3/D1). */
  multipartEntries?: MultipartEntry[];
};

export type MultipartTextPart = {
  kind: "text";
  name: string;
  value: string;
};

export type MultipartFilePart = {
  kind: "file";
  name: string;
  fileName: string;
  fileToken: string;
  contentType?: string;
};

export type MultipartEntry = MultipartTextPart | MultipartFilePart;

/** Renderer-side representation of an attached file (metadata only, D1). */
export type FormFileEntry = {
  name: string;
  fileName: string;
  /** Backend-issued one-time capability; never a filesystem path. */
  fileToken: string;
  contentType?: string;
};

// ---------------------------------------------------------------------------
// Breakpoint types
// ---------------------------------------------------------------------------

export function isComposedRequestInput(value: unknown): value is ComposedRequestInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ComposedRequestInput>;
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(isHeaderEntry) &&
    (candidate.body === undefined || typeof candidate.body === "string") &&
    (candidate.multipartEntries === undefined ||
      (Array.isArray(candidate.multipartEntries) &&
        candidate.multipartEntries.every(
          (entry) =>
            (entry.kind === "text" &&
              typeof entry.name === "string" &&
              typeof entry.value === "string") ||
            (entry.kind === "file" &&
              typeof entry.name === "string" &&
              typeof entry.fileName === "string" &&
              typeof entry.fileToken === "string"),
        )))
  );
}

export function createMockComposeSessionDetail(input: ComposedRequestInput): SessionDetail {
  const now = new Date().toISOString();
  const id = "mock-compose-" + Math.random().toString(36).slice(2, 10);
  const url = new URL(input.url);
  const scheme = url.protocol.replace(":", "");
  return {
    id,
    summary: {
      id,
      method: input.method,
      host: url.host,
      path: url.pathname,
      protocol: scheme,
      scheme: scheme === "https" ? "https" : "http",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http",
      startedAt: now,
      finishedAt: now,
      durationMs: 42,
      sizeBytes: 128,
      statusCode: 200,
      url: input.url,
      responseMimeType: "application/json",
    },
    requestHeaders: input.headers,
    responseHeaders: [
      { name: "content-type", value: "application/json" },
      { name: "x-mock", value: "true" },
    ],
    queryParams: [],
    cookies: [],
    ...(input.body
      ? {
          requestBody: {
            inlineText: input.body,
            sizeBytes: input.body.length,
            mimeType: "text/plain",
          } as BodyReference,
        }
      : {}),
    responseBody: {
      inlineText: JSON.stringify(
        { ok: true, method: input.method, url: input.url, mock: true },
        null,
        2,
      ),
      sizeBytes: 128,
      mimeType: "application/json",
    },
    timing: { totalMs: 42, waitingMs: 30, responseReadMs: 12 },
  };
}
