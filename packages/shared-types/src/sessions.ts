import { AppError, isNullableBoolean, isNullableNumber, isNullableString } from "./common";
import {
  isMapSessionTrace,
  type MapSessionTrace,
  type RewriteSessionTrace,
  isRewriteSessionTrace,
  type ScriptSessionTrace,
  isScriptSessionTrace,
} from "./rules";
import { isThrottleSessionTrace, type ThrottleSessionTrace } from "./throttling";

export type SessionSummary = {
  id: string;
  method: string;
  host: string;
  path: string;
  protocol: string;
  scheme?: string;
  httpVersion?: string;
  transportProtocol?: string;
  applicationProtocol?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sizeBytes: number;
  statusCode: number;
  url: string;
  responseMimeType?: string;
};

export type HeaderEntry = {
  name: string;
  value: string;
  isPseudo?: boolean; // HTTP/2 pseudo header flag
};

export type BodyReference = {
  base64Text?: string;
  base64Deferred?: boolean;
  encoding?: string;
  inlineText?: string;
  mimeType?: string;
  sizeBytes: number;
  textDeferred?: boolean;
  truncated?: boolean;
};

export type TimingBreakdown = {
  connectMs?: number;
  dnsMs?: number;
  requestSendMs?: number;
  responseReadMs?: number;
  tlsMs?: number;
  totalMs?: number;
  waitingMs?: number;
};

export type SessionDetail = {
  clientAddress?: string;
  cookies: HeaderEntry[];
  id: string;
  queryParams: HeaderEntry[];
  rawRequestHead?: string;
  rawRequest?: string;
  rawRequestDeferred?: boolean;
  rawResponseHead?: string;
  rawResponse?: string;
  rawResponseDeferred?: boolean;
  requestBody?: BodyReference;
  requestHeaders: HeaderEntry[];
  responseBody?: BodyReference;
  responseHeaders: HeaderEntry[];
  serverIp?: string;
  summary: SessionSummary;
  mapTraces?: MapSessionTrace[];
  rewriteTraces?: RewriteSessionTrace[];
  scriptTraces?: ScriptSessionTrace[];
  throttleTraces?: ThrottleSessionTrace[];
  tlsCipherSuite?: string;
  tlsProtocol?: string;
  timing?: TimingBreakdown;
  timingSource?: "proxy" | "compose" | "har-import" | undefined;
  trailers?: HeaderEntry[]; // HTTP/2 response trailers
  h2StreamId?: number; // HTTP/2 stream ID for debugging
};

export type SessionDetailContentRequest = {
  sessionId: string;
  includeRawRequest?: boolean;
  includeRawResponse?: boolean;
  includeRequestBodyText?: boolean;
  includeResponseBodyText?: boolean;
  includeRequestBodyBase64?: boolean;
  includeResponseBodyBase64?: boolean;
};

export type SessionBodyContentPatch = {
  base64Deferred?: boolean;
  base64Text?: string;
  inlineText?: string;
  textDeferred?: boolean;
};

export type SessionDetailContentPatch = {
  sessionId: string;
  rawRequest?: string;
  rawRequestDeferred?: boolean;
  rawResponse?: string;
  rawResponseDeferred?: boolean;
  requestBody?: SessionBodyContentPatch;
  responseBody?: SessionBodyContentPatch;
};

export type SessionUpsertEvent = SessionSummary;

export type SessionRemoveEvent = string;

// ---------------------------------------------------------------------------
// Insights types
// ---------------------------------------------------------------------------

export type InsightsResult = {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  totalBytes: number;
  byHost: HostInsight[];
  byStatusCode: StatusCodeDistribution[];
  byMethod: MethodDistribution[];
  slowRequests: SlowRequest[];
  largestRequests: SlowRequest[];
};

export type HostInsight = {
  host: string;
  requestCount: number;
  errorCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  totalBytes: number;
};

export type StatusCodeDistribution = {
  statusCode: number;
  count: number;
};

export type MethodDistribution = {
  method: string;
  count: number;
};

export type SlowRequest = {
  sessionId: string;
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  sizeBytes: number;
};

export type GetInsightsInput = {
  excludedHosts?: string[];
  hostExact?: string;
  sessionIds: string[];
  hostKeyword?: string;
};

export function isSessionSummary(value: unknown): value is SessionSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionSummary>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.protocol === "string" &&
    isNullableString(candidate.scheme) &&
    isNullableString(candidate.httpVersion) &&
    isNullableString(candidate.transportProtocol) &&
    isNullableString(candidate.applicationProtocol) &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.finishedAt === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.statusCode === "number" &&
    typeof candidate.url === "string" &&
    isNullableString(candidate.responseMimeType)
  );
}

export function parseSessionSummaries(value: unknown): SessionSummary[] {
  if (!Array.isArray(value)) {
    throw {
      code: "INVALID_SESSION_SUMMARIES",
      message: "The session list payload must be an array.",
      details: {
        payload: value,
      },
    } satisfies AppError;
  }

  if (value.every(isSessionSummary)) {
    return value;
  }

  throw {
    code: "INVALID_SESSION_SUMMARIES",
    message: "One or more captured sessions do not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function parseSessionSummary(value: unknown): SessionSummary {
  if (isSessionSummary(value)) {
    return value;
  }

  throw {
    code: "INVALID_SESSION_SUMMARY",
    message: "The session summary payload does not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function isHeaderEntry(value: unknown): value is HeaderEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<HeaderEntry>;

  return typeof candidate.name === "string" && typeof candidate.value === "string";
}

export function isBodyReference(value: unknown): value is BodyReference {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<BodyReference> & {
    base64Deferred?: boolean | null;
    base64Text?: string | null;
    encoding?: string | null;
    inlineText?: string | null;
    mimeType?: string | null;
    textDeferred?: boolean | null;
    truncated?: boolean | null;
  };

  return (
    typeof candidate.sizeBytes === "number" &&
    isNullableString(candidate.inlineText) &&
    isNullableString(candidate.base64Text) &&
    isNullableBoolean(candidate.textDeferred) &&
    isNullableBoolean(candidate.base64Deferred) &&
    isNullableString(candidate.mimeType) &&
    isNullableString(candidate.encoding) &&
    isNullableBoolean(candidate.truncated)
  );
}

type WireTimingBreakdown = TimingBreakdown & {
  connect_ms?: number | null;
  dns_ms?: number | null;
  request_send_ms?: number | null;
  response_read_ms?: number | null;
  tls_ms?: number | null;
  total_ms?: number | null;
  waiting_ms?: number | null;
};

export function isTimingBreakdown(value: unknown): value is TimingBreakdown {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<WireTimingBreakdown>;
  const timingFields = [
    candidate.connectMs,
    candidate.connect_ms,
    candidate.dnsMs,
    candidate.dns_ms,
    candidate.requestSendMs,
    candidate.request_send_ms,
    candidate.responseReadMs,
    candidate.response_read_ms,
    candidate.tlsMs,
    candidate.tls_ms,
    candidate.totalMs,
    candidate.total_ms,
    candidate.waitingMs,
    candidate.waiting_ms,
  ];

  return timingFields.every(isNullableNumber);
}

export function isSessionDetail(value: unknown): value is SessionDetail {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionDetail> & {
    clientAddress?: string | null;
    rawRequestHead?: string | null;
    rawRequest?: string | null;
    rawRequestDeferred?: boolean | null;
    rawResponseHead?: string | null;
    rawResponse?: string | null;
    rawResponseDeferred?: boolean | null;
    requestBody?: BodyReference | null;
    responseBody?: BodyReference | null;
    serverIp?: string | null;
    tlsCipherSuite?: string | null;
    tlsProtocol?: string | null;
    mapTraces?: MapSessionTrace[] | null;
    rewriteTraces?: RewriteSessionTrace[] | null;
    scriptTraces?: ScriptSessionTrace[] | null;
    throttleTraces?: ThrottleSessionTrace[] | null;
    timing?: TimingBreakdown | null;
    trailers?: HeaderEntry[] | null;
    h2StreamId?: number | null;
  };

  return (
    typeof candidate.id === "string" &&
    isSessionSummary(candidate.summary) &&
    Array.isArray(candidate.requestHeaders) &&
    candidate.requestHeaders.every(isHeaderEntry) &&
    Array.isArray(candidate.responseHeaders) &&
    candidate.responseHeaders.every(isHeaderEntry) &&
    Array.isArray(candidate.queryParams) &&
    candidate.queryParams.every(isHeaderEntry) &&
    Array.isArray(candidate.cookies) &&
    candidate.cookies.every(isHeaderEntry) &&
    isNullableString(candidate.clientAddress) &&
    (candidate.requestBody === undefined ||
      candidate.requestBody === null ||
      isBodyReference(candidate.requestBody)) &&
    (candidate.responseBody === undefined ||
      candidate.responseBody === null ||
      isBodyReference(candidate.responseBody)) &&
    (candidate.mapTraces === undefined ||
      candidate.mapTraces === null ||
      (Array.isArray(candidate.mapTraces) && candidate.mapTraces.every(isMapSessionTrace))) &&
    (candidate.rewriteTraces === undefined ||
      candidate.rewriteTraces === null ||
      (Array.isArray(candidate.rewriteTraces) &&
        candidate.rewriteTraces.every(isRewriteSessionTrace))) &&
    (candidate.scriptTraces === undefined ||
      candidate.scriptTraces === null ||
      (Array.isArray(candidate.scriptTraces) &&
        candidate.scriptTraces.every(isScriptSessionTrace))) &&
    (candidate.throttleTraces === undefined ||
      candidate.throttleTraces === null ||
      (Array.isArray(candidate.throttleTraces) &&
        candidate.throttleTraces.every(isThrottleSessionTrace))) &&
    (candidate.timing === undefined ||
      candidate.timing === null ||
      isTimingBreakdown(candidate.timing)) &&
    (candidate.trailers === undefined ||
      candidate.trailers === null ||
      (Array.isArray(candidate.trailers) && candidate.trailers.every(isHeaderEntry))) &&
    isNullableNumber(candidate.h2StreamId) &&
    isNullableString(candidate.rawRequestHead) &&
    isNullableString(candidate.rawRequest) &&
    isNullableBoolean(candidate.rawRequestDeferred) &&
    isNullableString(candidate.rawResponseHead) &&
    isNullableString(candidate.rawResponse) &&
    isNullableBoolean(candidate.rawResponseDeferred) &&
    isNullableString(candidate.serverIp) &&
    isNullableString(candidate.tlsCipherSuite) &&
    isNullableString(candidate.tlsProtocol)
  );
}

export function parseSessionDetail(value: unknown): SessionDetail {
  if (isSessionDetail(value)) {
    const candidate = value as SessionDetail & {
      clientAddress?: string | null;
      rawRequestHead?: string | null;
      rawRequest?: string | null;
      rawRequestDeferred?: boolean | null;
      rawResponseHead?: string | null;
      rawResponse?: string | null;
      rawResponseDeferred?: boolean | null;
      requestBody?: BodyReference | null;
      responseBody?: BodyReference | null;
      serverIp?: string | null;
      tlsCipherSuite?: string | null;
      tlsProtocol?: string | null;
      mapTraces?: MapSessionTrace[] | null;
      throttleTraces?: ThrottleSessionTrace[] | null;
      timing?: TimingBreakdown | null;
      rewriteTraces?: RewriteSessionTrace[] | null;
      scriptTraces?: ScriptSessionTrace[] | null;
      trailers?: HeaderEntry[] | null;
      h2StreamId?: number | null;
    };

    return {
      cookies: candidate.cookies,
      ...(candidate.clientAddress !== null && candidate.clientAddress !== undefined
        ? { clientAddress: candidate.clientAddress }
        : {}),
      id: candidate.id,
      queryParams: candidate.queryParams,
      ...(candidate.rawRequestHead !== null && candidate.rawRequestHead !== undefined
        ? { rawRequestHead: candidate.rawRequestHead }
        : {}),
      requestHeaders: candidate.requestHeaders,
      ...(candidate.rawResponseHead !== null && candidate.rawResponseHead !== undefined
        ? { rawResponseHead: candidate.rawResponseHead }
        : {}),
      responseHeaders: candidate.responseHeaders,
      summary: candidate.summary,
      ...(candidate.rawRequest !== null && candidate.rawRequest !== undefined
        ? { rawRequest: candidate.rawRequest }
        : {}),
      ...(candidate.rawRequestDeferred !== null && candidate.rawRequestDeferred !== undefined
        ? { rawRequestDeferred: candidate.rawRequestDeferred }
        : {}),
      ...(candidate.rawResponse !== null && candidate.rawResponse !== undefined
        ? { rawResponse: candidate.rawResponse }
        : {}),
      ...(candidate.rawResponseDeferred !== null && candidate.rawResponseDeferred !== undefined
        ? { rawResponseDeferred: candidate.rawResponseDeferred }
        : {}),
      ...(candidate.requestBody !== null && candidate.requestBody !== undefined
        ? { requestBody: normalizeBodyReference(candidate.requestBody) }
        : {}),
      ...(candidate.responseBody !== null && candidate.responseBody !== undefined
        ? { responseBody: normalizeBodyReference(candidate.responseBody) }
        : {}),
      ...(candidate.serverIp !== null && candidate.serverIp !== undefined
        ? { serverIp: candidate.serverIp }
        : {}),
      ...(candidate.mapTraces !== null && candidate.mapTraces !== undefined
        ? { mapTraces: candidate.mapTraces }
        : {}),
      ...(candidate.throttleTraces !== null && candidate.throttleTraces !== undefined
        ? { throttleTraces: candidate.throttleTraces }
        : {}),
      ...(candidate.tlsCipherSuite !== null && candidate.tlsCipherSuite !== undefined
        ? { tlsCipherSuite: candidate.tlsCipherSuite }
        : {}),
      ...(candidate.tlsProtocol !== null && candidate.tlsProtocol !== undefined
        ? { tlsProtocol: candidate.tlsProtocol }
        : {}),
      ...(candidate.timing !== null && candidate.timing !== undefined
        ? { timing: normalizeTimingBreakdown(candidate.timing) }
        : {}),
      ...(candidate.timingSource !== null && candidate.timingSource !== undefined
        ? { timingSource: candidate.timingSource as SessionDetail["timingSource"] }
        : {}),
      ...(candidate.rewriteTraces !== null && candidate.rewriteTraces !== undefined
        ? { rewriteTraces: candidate.rewriteTraces }
        : {}),
      ...(candidate.scriptTraces !== null && candidate.scriptTraces !== undefined
        ? { scriptTraces: candidate.scriptTraces }
        : {}),
      ...(candidate.trailers !== null && candidate.trailers !== undefined
        ? { trailers: candidate.trailers }
        : {}),
      ...(candidate.h2StreamId !== null && candidate.h2StreamId !== undefined
        ? { h2StreamId: candidate.h2StreamId }
        : {}),
    };
  }

  throw {
    code: "INVALID_SESSION_DETAIL",
    message: "The session detail payload does not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function normalizeBodyReference(
  bodyReference: BodyReference & {
    base64Deferred?: boolean | null;
    base64Text?: string | null;
    encoding?: string | null;
    inlineText?: string | null;
    mimeType?: string | null;
    textDeferred?: boolean | null;
    truncated?: boolean | null;
  },
): BodyReference {
  return {
    sizeBytes: bodyReference.sizeBytes,
    ...(bodyReference.base64Deferred !== null && bodyReference.base64Deferred !== undefined
      ? { base64Deferred: bodyReference.base64Deferred }
      : {}),
    ...(bodyReference.base64Text !== null && bodyReference.base64Text !== undefined
      ? { base64Text: bodyReference.base64Text }
      : {}),
    ...(bodyReference.encoding !== null && bodyReference.encoding !== undefined
      ? { encoding: bodyReference.encoding }
      : {}),
    ...(bodyReference.inlineText !== null && bodyReference.inlineText !== undefined
      ? { inlineText: bodyReference.inlineText }
      : {}),
    ...(bodyReference.mimeType !== null && bodyReference.mimeType !== undefined
      ? { mimeType: bodyReference.mimeType }
      : {}),
    ...(bodyReference.textDeferred !== null && bodyReference.textDeferred !== undefined
      ? { textDeferred: bodyReference.textDeferred }
      : {}),
    ...(bodyReference.truncated !== null && bodyReference.truncated !== undefined
      ? { truncated: bodyReference.truncated }
      : {}),
  };
}

function isSessionBodyContentPatch(value: unknown): value is SessionBodyContentPatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionBodyContentPatch> & {
    base64Deferred?: boolean | null;
    base64Text?: string | null;
    inlineText?: string | null;
    textDeferred?: boolean | null;
  };

  return (
    isNullableString(candidate.inlineText) &&
    isNullableString(candidate.base64Text) &&
    isNullableBoolean(candidate.textDeferred) &&
    isNullableBoolean(candidate.base64Deferred)
  );
}

export function isSessionDetailContentPatch(value: unknown): value is SessionDetailContentPatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionDetailContentPatch> & {
    rawRequest?: string | null;
    rawRequestDeferred?: boolean | null;
    rawResponse?: string | null;
    rawResponseDeferred?: boolean | null;
    requestBody?: SessionBodyContentPatch | null;
    responseBody?: SessionBodyContentPatch | null;
  };

  return (
    typeof candidate.sessionId === "string" &&
    isNullableString(candidate.rawRequest) &&
    isNullableBoolean(candidate.rawRequestDeferred) &&
    isNullableString(candidate.rawResponse) &&
    isNullableBoolean(candidate.rawResponseDeferred) &&
    (candidate.requestBody === undefined ||
      candidate.requestBody === null ||
      isSessionBodyContentPatch(candidate.requestBody)) &&
    (candidate.responseBody === undefined ||
      candidate.responseBody === null ||
      isSessionBodyContentPatch(candidate.responseBody))
  );
}

export function parseSessionDetailContentPatch(value: unknown): SessionDetailContentPatch {
  if (!isSessionDetailContentPatch(value)) {
    throw {
      code: "INVALID_SESSION_DETAIL_CONTENT_PATCH",
      message: "The session detail content patch payload does not match the shared contract.",
      details: {
        payload: value,
      },
    } satisfies AppError;
  }

  const candidate = value as SessionDetailContentPatch & {
    rawRequest?: string | null;
    rawRequestDeferred?: boolean | null;
    rawResponse?: string | null;
    rawResponseDeferred?: boolean | null;
    requestBody?: SessionBodyContentPatch | null;
    responseBody?: SessionBodyContentPatch | null;
  };

  return {
    sessionId: candidate.sessionId,
    ...(candidate.rawRequest !== null && candidate.rawRequest !== undefined
      ? { rawRequest: candidate.rawRequest }
      : {}),
    ...(candidate.rawRequestDeferred !== null && candidate.rawRequestDeferred !== undefined
      ? { rawRequestDeferred: candidate.rawRequestDeferred }
      : {}),
    ...(candidate.rawResponse !== null && candidate.rawResponse !== undefined
      ? { rawResponse: candidate.rawResponse }
      : {}),
    ...(candidate.rawResponseDeferred !== null && candidate.rawResponseDeferred !== undefined
      ? { rawResponseDeferred: candidate.rawResponseDeferred }
      : {}),
    ...(candidate.requestBody !== null && candidate.requestBody !== undefined
      ? { requestBody: normalizeSessionBodyContentPatch(candidate.requestBody) }
      : {}),
    ...(candidate.responseBody !== null && candidate.responseBody !== undefined
      ? { responseBody: normalizeSessionBodyContentPatch(candidate.responseBody) }
      : {}),
  };
}

function normalizeSessionBodyContentPatch(
  patch: SessionBodyContentPatch & {
    base64Deferred?: boolean | null;
    base64Text?: string | null;
    inlineText?: string | null;
    textDeferred?: boolean | null;
  },
): SessionBodyContentPatch {
  return {
    ...(patch.inlineText !== null && patch.inlineText !== undefined
      ? { inlineText: patch.inlineText }
      : {}),
    ...(patch.base64Text !== null && patch.base64Text !== undefined
      ? { base64Text: patch.base64Text }
      : {}),
    ...(patch.textDeferred !== null && patch.textDeferred !== undefined
      ? { textDeferred: patch.textDeferred }
      : {}),
    ...(patch.base64Deferred !== null && patch.base64Deferred !== undefined
      ? { base64Deferred: patch.base64Deferred }
      : {}),
  };
}

export function mergeSessionDetailContent(
  detail: SessionDetail,
  patch: SessionDetailContentPatch,
): SessionDetail {
  if (patch.sessionId !== detail.id) {
    throw {
      code: "SESSION_DETAIL_CONTENT_PATCH_MISMATCH",
      message: "The session detail content patch does not match the target session.",
      details: {
        detailId: detail.id,
        patchSessionId: patch.sessionId,
      },
    } satisfies AppError;
  }

  const nextRequestBody = mergeBodyReferenceContent(detail.requestBody, patch.requestBody);
  const nextResponseBody = mergeBodyReferenceContent(detail.responseBody, patch.responseBody);

  const nextDetail: SessionDetail = {
    ...detail,
    ...(patch.rawRequest !== undefined ? { rawRequest: patch.rawRequest } : {}),
    ...(patch.rawResponse !== undefined ? { rawResponse: patch.rawResponse } : {}),
    ...(nextRequestBody ? { requestBody: nextRequestBody } : {}),
    ...(nextResponseBody ? { responseBody: nextResponseBody } : {}),
  };

  if (patch.rawRequestDeferred === true) {
    nextDetail.rawRequestDeferred = true;
  } else if (patch.rawRequestDeferred === false) {
    delete nextDetail.rawRequestDeferred;
  }

  if (patch.rawResponseDeferred === true) {
    nextDetail.rawResponseDeferred = true;
  } else if (patch.rawResponseDeferred === false) {
    delete nextDetail.rawResponseDeferred;
  }

  return nextDetail;
}

function mergeBodyReferenceContent(
  body: BodyReference | undefined,
  patch: SessionBodyContentPatch | undefined,
): BodyReference | undefined {
  if (!body) {
    return body;
  }

  if (!patch) {
    return body;
  }

  const nextBody: BodyReference = {
    ...body,
    ...(patch.inlineText !== undefined ? { inlineText: patch.inlineText } : {}),
    ...(patch.base64Text !== undefined ? { base64Text: patch.base64Text } : {}),
  };

  if (patch.textDeferred === true) {
    nextBody.textDeferred = true;
  } else if (patch.textDeferred === false) {
    delete nextBody.textDeferred;
  }

  if (patch.base64Deferred === true) {
    nextBody.base64Deferred = true;
  } else if (patch.base64Deferred === false) {
    delete nextBody.base64Deferred;
  }

  return nextBody;
}

function normalizeTimingBreakdown(timing: WireTimingBreakdown): TimingBreakdown {
  const connectMs = timing.connectMs ?? timing.connect_ms;
  const dnsMs = timing.dnsMs ?? timing.dns_ms;
  const requestSendMs = timing.requestSendMs ?? timing.request_send_ms;
  const responseReadMs = timing.responseReadMs ?? timing.response_read_ms;
  const tlsMs = timing.tlsMs ?? timing.tls_ms;
  const totalMs = timing.totalMs ?? timing.total_ms;
  const waitingMs = timing.waitingMs ?? timing.waiting_ms;

  return {
    ...(connectMs !== null && connectMs !== undefined ? { connectMs } : {}),
    ...(dnsMs !== null && dnsMs !== undefined ? { dnsMs } : {}),
    ...(requestSendMs !== null && requestSendMs !== undefined ? { requestSendMs } : {}),
    ...(responseReadMs !== null && responseReadMs !== undefined ? { responseReadMs } : {}),
    ...(tlsMs !== null && tlsMs !== undefined ? { tlsMs } : {}),
    ...(totalMs !== null && totalMs !== undefined ? { totalMs } : {}),
    ...(waitingMs !== null && waitingMs !== undefined ? { waitingMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Insights validators
// ---------------------------------------------------------------------------

function isHostInsight(value: unknown): value is HostInsight {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<HostInsight>;

  return (
    typeof candidate.host === "string" &&
    typeof candidate.requestCount === "number" &&
    typeof candidate.errorCount === "number" &&
    typeof candidate.avgDurationMs === "number" &&
    typeof candidate.p95DurationMs === "number" &&
    typeof candidate.totalBytes === "number"
  );
}

function isStatusCodeDistribution(value: unknown): value is StatusCodeDistribution {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<StatusCodeDistribution>;

  return typeof candidate.statusCode === "number" && typeof candidate.count === "number";
}

function isMethodDistribution(value: unknown): value is MethodDistribution {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<MethodDistribution>;

  return typeof candidate.method === "string" && typeof candidate.count === "number";
}

function isSlowRequest(value: unknown): value is SlowRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SlowRequest>;

  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.statusCode === "number" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.sizeBytes === "number"
  );
}

function isInsightsResult(value: unknown): value is InsightsResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<InsightsResult>;

  return (
    typeof candidate.totalRequests === "number" &&
    typeof candidate.totalErrors === "number" &&
    typeof candidate.errorRate === "number" &&
    typeof candidate.avgDurationMs === "number" &&
    typeof candidate.p50DurationMs === "number" &&
    typeof candidate.p95DurationMs === "number" &&
    typeof candidate.p99DurationMs === "number" &&
    typeof candidate.totalBytes === "number" &&
    Array.isArray(candidate.byHost) &&
    candidate.byHost.every(isHostInsight) &&
    Array.isArray(candidate.byStatusCode) &&
    candidate.byStatusCode.every(isStatusCodeDistribution) &&
    Array.isArray(candidate.byMethod) &&
    candidate.byMethod.every(isMethodDistribution) &&
    Array.isArray(candidate.slowRequests) &&
    candidate.slowRequests.every(isSlowRequest) &&
    Array.isArray(candidate.largestRequests) &&
    candidate.largestRequests.every(isSlowRequest)
  );
}

export function parseInsightsResult(value: unknown): InsightsResult {
  if (isInsightsResult(value)) {
    return value;
  }

  throw {
    code: "INVALID_INSIGHTS_RESULT",
    message: "The insights result payload does not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function isGetInsightsInput(value: unknown): value is GetInsightsInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<GetInsightsInput>;

  return (
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every((id) => typeof id === "string") &&
    (candidate.hostKeyword === undefined || typeof candidate.hostKeyword === "string") &&
    (candidate.hostExact === undefined || typeof candidate.hostExact === "string") &&
    (candidate.excludedHosts === undefined ||
      (Array.isArray(candidate.excludedHosts) &&
        candidate.excludedHosts.every((host) => typeof host === "string")))
  );
}
