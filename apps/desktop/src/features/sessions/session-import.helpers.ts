import type {
  BodyReference,
  HeaderEntry,
  SessionDetail,
  TimingBreakdown,
} from "@aiproxy/shared-types";

import { inferProtocolMetadata, resolveHttpVersion } from "./session-protocol.helpers";

type HarHeader = {
  name?: string;
  value?: string;
};

type HarBody = {
  encoding?: string;
  mimeType?: string;
  text?: string;
};

type HarEntry = {
  startedDateTime?: string;
  time?: number;
  timings?: {
    connect?: number;
    dns?: number;
    receive?: number;
    send?: number;
    ssl?: number;
    wait?: number;
  };
  request?: {
    headers?: HarHeader[];
    httpVersion?: string;
    method?: string;
    postData?: HarBody;
    queryString?: HarHeader[];
    url?: string;
  };
  response?: {
    content?: HarBody & { size?: number };
    headers?: HarHeader[];
    status?: number;
  };
};

function coerceHeaders(headers: HarHeader[] | undefined): HeaderEntry[] {
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers.flatMap((header) => {
    if (typeof header.name !== "string" || typeof header.value !== "string") {
      return [];
    }

    return [{ name: header.name, value: header.value }];
  });
}

function buildBodyReference(
  body: HarBody | undefined,
  fallbackSize = 0,
): BodyReference | undefined {
  if (!body || typeof body.text !== "string") {
    return undefined;
  }

  const sizeBytes = Math.max(body.text.length, fallbackSize);

  if (body.encoding === "base64") {
    return {
      ...(body.mimeType ? { mimeType: body.mimeType } : {}),
      base64Text: body.text,
      sizeBytes,
    };
  }

  return {
    ...(body.mimeType ? { mimeType: body.mimeType } : {}),
    inlineText: body.text,
    sizeBytes,
  };
}

function buildTimingBreakdown(entry: HarEntry): TimingBreakdown | undefined {
  const timings = entry.timings;

  if (!timings) {
    return undefined;
  }

  const connectMs =
    typeof timings.connect === "number" && timings.connect >= 0 ? timings.connect : undefined;
  const dnsMs = typeof timings.dns === "number" && timings.dns >= 0 ? timings.dns : undefined;
  const requestSendMs =
    typeof timings.send === "number" && timings.send >= 0 ? timings.send : undefined;
  const responseReadMs =
    typeof timings.receive === "number" && timings.receive >= 0 ? timings.receive : undefined;
  const tlsMs = typeof timings.ssl === "number" && timings.ssl >= 0 ? timings.ssl : undefined;
  const waitingMs =
    typeof timings.wait === "number" && timings.wait >= 0 ? timings.wait : undefined;
  const totalMs =
    typeof entry.time === "number" && entry.time >= 0
      ? entry.time
      : [connectMs, dnsMs, requestSendMs, responseReadMs, tlsMs, waitingMs]
          .filter((value): value is number => typeof value === "number")
          .reduce((sum, value) => sum + value, 0);

  if (
    connectMs === undefined &&
    dnsMs === undefined &&
    requestSendMs === undefined &&
    responseReadMs === undefined &&
    tlsMs === undefined &&
    waitingMs === undefined &&
    totalMs === 0
  ) {
    return undefined;
  }

  return {
    ...(connectMs !== undefined ? { connectMs } : {}),
    ...(dnsMs !== undefined ? { dnsMs } : {}),
    ...(requestSendMs !== undefined ? { requestSendMs } : {}),
    ...(responseReadMs !== undefined ? { responseReadMs } : {}),
    ...(tlsMs !== undefined ? { tlsMs } : {}),
    totalMs,
    ...(waitingMs !== undefined ? { waitingMs } : {}),
  };
}

function buildImportedId(index: number) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `imported-har-${crypto.randomUUID()}`;
  }

  return `imported-har-${Date.now()}-${index}`;
}

function parseHarEntry(entry: HarEntry, index: number): SessionDetail {
  const request = entry.request;

  if (!request || typeof request.method !== "string" || typeof request.url !== "string") {
    throw new Error(`Entry ${index + 1} is missing a valid request method or URL.`);
  }

  const parsedUrl = new URL(request.url);
  const startedAt =
    typeof entry.startedDateTime === "string" &&
    !Number.isNaN(new Date(entry.startedDateTime).getTime())
      ? entry.startedDateTime
      : new Date().toISOString();
  const durationMs = typeof entry.time === "number" && entry.time >= 0 ? entry.time : 0;
  const finishedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
  const sessionId = buildImportedId(index);
  const queryParams =
    request.queryString && request.queryString.length > 0
      ? coerceHeaders(request.queryString)
      : Array.from(parsedUrl.searchParams.entries(), ([name, value]) => ({ name, value }));
  const requestHeaders = coerceHeaders(request.headers);
  const responseHeaders = coerceHeaders(entry.response?.headers);
  const requestBody = buildBodyReference(request.postData);
  const responseBody = buildBodyReference(entry.response?.content, entry.response?.content?.size);
  const timing = buildTimingBreakdown(entry);
  const protocol = parsedUrl.protocol.replace(":", "");
  const harHttpVersion = request?.httpVersion || "HTTP/1.1";
  const protocolMetadata = inferProtocolMetadata(protocol, request.url);

  return {
    cookies: [],
    id: sessionId,
    queryParams,
    ...(requestBody ? { requestBody } : {}),
    requestHeaders,
    ...(responseBody ? { responseBody } : {}),
    responseHeaders,
    summary: {
      durationMs,
      finishedAt,
      host: parsedUrl.host,
      id: sessionId,
      method: request.method,
      path: `${parsedUrl.pathname || "/"}${parsedUrl.search}`,
      protocol,
      scheme: protocolMetadata.scheme,
      httpVersion: resolveHttpVersion(harHttpVersion, harHttpVersion.toLowerCase()),
      transportProtocol: protocolMetadata.transportProtocol,
      applicationProtocol: protocolMetadata.applicationProtocol,
      sizeBytes:
        responseBody?.sizeBytes ??
        (typeof entry.response?.content?.size === "number" ? entry.response.content.size : 0),
      startedAt,
      statusCode: typeof entry.response?.status === "number" ? entry.response.status : 0,
      url: request.url,
      ...(entry.response?.content?.mimeType
        ? { responseMimeType: entry.response.content.mimeType }
        : {}),
    },
    ...(timing ? { timing } : {}),
  };
}

export function parseHarArchive(contents: string): SessionDetail[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("log" in parsed) ||
    typeof parsed.log !== "object" ||
    parsed.log === null ||
    !("entries" in parsed.log) ||
    !Array.isArray(parsed.log.entries)
  ) {
    throw new Error("The selected file is not a valid HAR archive.");
  }

  if (parsed.log.entries.length === 0) {
    throw new Error("The selected HAR archive does not contain any entries.");
  }

  return parsed.log.entries.map((entry, index) => parseHarEntry(entry as HarEntry, index));
}
