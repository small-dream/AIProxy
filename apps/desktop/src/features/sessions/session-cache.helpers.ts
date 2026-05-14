import type {
  BodyReference,
  ComposedRequestInput,
  HeaderEntry,
  SessionDetail,
  SessionSummary,
  TimingBreakdown,
} from "@aiproxy/shared-types";

import { inferProtocolMetadata } from "./session-protocol.helpers";

export function upsertSessionSummary(
  sessions: SessionSummary[],
  nextSession: SessionSummary,
): SessionSummary[] {
  const existingIndex = sessions.findIndex((session) => session.id === nextSession.id);

  if (existingIndex === -1) {
    return [...sessions, nextSession];
  }

  return sessions.map((session, index) => (index === existingIndex ? nextSession : session));
}

export function removeSessionSummary(
  sessions: SessionSummary[],
  sessionId: string,
): SessionSummary[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function removeSessionSummaries(
  sessions: SessionSummary[],
  sessionIds: string[],
): SessionSummary[] {
  const idsSet = new Set(sessionIds);
  return sessions.filter((session) => !idsSet.has(session.id));
}

export function replaceSessionSummary(
  sessions: SessionSummary[],
  previousSessionId: string,
  nextSession: SessionSummary,
): SessionSummary[] {
  const existingIndex = sessions.findIndex((session) => session.id === previousSessionId);

  if (existingIndex === -1) {
    return upsertSessionSummary(sessions, nextSession);
  }

  return sessions.map((session, index) => (index === existingIndex ? nextSession : session));
}

export function buildPendingComposedSessionDetail(
  input: ComposedRequestInput,
  sessionId: string,
): SessionDetail | undefined {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(input.url);
  } catch {
    return undefined;
  }

  const startedAt = new Date().toISOString();
  const path = `${parsedUrl.pathname || "/"}${parsedUrl.search}`;
  const bodyText = input.body ?? "";
  const contentType = findHeaderValue(input.headers, "content-type");

  const protocol = parsedUrl.protocol.replace(":", "");
  const protocolMetadata = inferProtocolMetadata(protocol, input.url);

  return {
    cookies: [],
    id: sessionId,
    queryParams: Array.from(parsedUrl.searchParams.entries()).map(([name, value]) => ({ name, value })),
    rawRequest: buildRawRequest(input.method, path, input.headers, bodyText),
    requestHeaders: input.headers,
    responseHeaders: [],
    summary: {
      durationMs: 0,
      finishedAt: startedAt,
      host: parsedUrl.host,
      id: sessionId,
      method: input.method,
      path,
      protocol,
      scheme: protocolMetadata.scheme,
      httpVersion: protocolMetadata.httpVersion,
      transportProtocol: protocolMetadata.transportProtocol,
      applicationProtocol: protocolMetadata.applicationProtocol,
      sizeBytes: 0,
      startedAt,
      statusCode: 0,
      url: input.url,
    },
    ...(bodyText
      ? {
          requestBody: buildInlineBodyReference(bodyText, contentType),
        }
      : {}),
    timing: buildPendingTiming(),
  };
}

function findHeaderValue(headers: HeaderEntry[], name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === normalizedName)?.value;
}

function buildRawRequest(
  method: string,
  path: string,
  headers: HeaderEntry[],
  bodyText: string,
): string {
  const headerLines = headers.map((header) => `${header.name}: ${header.value}`).join("\r\n");
  const headerSection = headerLines.length > 0 ? `${headerLines}\r\n` : "";
  const bodySection = bodyText.length > 0 ? bodyText : "";

  return `${method} ${path} HTTP/1.1\r\n${headerSection}\r\n${bodySection}`;
}

function buildInlineBodyReference(bodyText: string, mimeType: string | undefined): BodyReference {
  return {
    inlineText: bodyText,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: bodyText.length,
  };
}

function buildPendingTiming(): TimingBreakdown {
  return {
    totalMs: 0,
  };
}
