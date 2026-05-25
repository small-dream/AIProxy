import type { SessionSummary } from "@aiproxy/shared-types";

export type SessionProtocolMetadata = {
  scheme: string;
  httpVersion: string;
  transportProtocol: string;
  applicationProtocol: string;
};

export function inferSessionProtocolMetadata(session: Pick<SessionSummary, "protocol" | "url">): SessionProtocolMetadata {
  return inferProtocolMetadata(session.protocol, session.url);
}

export function inferProtocolMetadata(protocol: string | undefined, urlValue: string | undefined): SessionProtocolMetadata {
  const normalizedProtocol = protocol?.trim().toLowerCase() ?? "";
  const urlScheme = getUrlScheme(urlValue);
  const scheme = resolveScheme(normalizedProtocol, urlScheme);
  const httpVersion = resolveHttpVersion(protocol, normalizedProtocol);
  const transportProtocol = httpVersion === "3" || normalizedProtocol === "h3" || normalizedProtocol === "http3"
    ? "quic"
    : "tcp";
  const applicationProtocol = resolveApplicationProtocol(normalizedProtocol);

  return {
    scheme,
    httpVersion,
    transportProtocol,
    applicationProtocol,
  };
}

export function getSessionProtocolMetadata(session: SessionSummary): SessionProtocolMetadata {
  const fallback = inferSessionProtocolMetadata(session);

  return {
    scheme: session.scheme ?? fallback.scheme,
    httpVersion: session.httpVersion ?? fallback.httpVersion,
    transportProtocol: session.transportProtocol ?? fallback.transportProtocol,
    applicationProtocol: session.applicationProtocol ?? fallback.applicationProtocol,
  };
}

export function formatSessionProtocol(session: SessionSummary): string {
  const metadata = getSessionProtocolMetadata(session);
  const applicationPrefix = metadata.applicationProtocol === "http"
    ? "HTTP"
    : metadata.applicationProtocol.toUpperCase();

  return `${applicationPrefix}/${metadata.httpVersion}`;
}

export function isWebSocketSessionProtocol(session: SessionSummary): boolean {
  return getSessionProtocolMetadata(session).applicationProtocol === "websocket"
    || session.protocol === "ws"
    || session.protocol === "wss"
    || session.responseMimeType === "websocket";
}

function getUrlScheme(urlValue: string | undefined): string | undefined {
  if (!urlValue) {
    return undefined;
  }

  try {
    const scheme = new URL(urlValue).protocol.replace(":", "").toLowerCase();
    return scheme || undefined;
  } catch {
    return undefined;
  }
}

function resolveScheme(normalizedProtocol: string, urlScheme: string | undefined): string {
  if (normalizedProtocol === "http" || normalizedProtocol === "https") {
    return normalizedProtocol;
  }

  if (normalizedProtocol === "ws") {
    return "http";
  }

  if (normalizedProtocol === "wss") {
    return "https";
  }

  if (urlScheme === "http" || urlScheme === "https") {
    return urlScheme;
  }

  return "http";
}

export function resolveHttpVersion(protocol: string | undefined, normalizedProtocol: string): string {
  const trimmedProtocol = protocol?.trim() ?? "";

  if (trimmedProtocol.startsWith("HTTP/")) {
    return trimmedProtocol.slice("HTTP/".length);
  }

  if (normalizedProtocol === "2" || normalizedProtocol === "h2" || normalizedProtocol === "http2") {
    return "2";
  }

  if (normalizedProtocol === "3" || normalizedProtocol === "h3" || normalizedProtocol === "http3") {
    return "3";
  }

  if (/^\d(?:\.\d)?$/.test(normalizedProtocol)) {
    return normalizedProtocol;
  }

  return "1.1";
}

function resolveApplicationProtocol(normalizedProtocol: string): string {
  if (normalizedProtocol === "ws" || normalizedProtocol === "wss") {
    return "websocket";
  }

  if (normalizedProtocol === "grpc" || normalizedProtocol === "grpc-web") {
    return normalizedProtocol;
  }

  return "http";
}
