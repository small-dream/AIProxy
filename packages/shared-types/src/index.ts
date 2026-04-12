export type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type Workspace = {
  id: string;
  name: string;
  proxyPort: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
};

export type ProxyStatus = {
  running: boolean;
  port: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  activeWorkspaceId?: string;
  startedAt?: string;
};

export type SessionSummary = {
  id: string;
  method: string;
  host: string;
  path: string;
  protocol: string;
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
};

export type BodyReference = {
  base64Text?: string;
  encoding?: string;
  inlineText?: string;
  mimeType?: string;
  sizeBytes: number;
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
  cookies: HeaderEntry[];
  id: string;
  queryParams: HeaderEntry[];
  rawRequest?: string;
  rawResponse?: string;
  requestBody?: BodyReference;
  requestHeaders: HeaderEntry[];
  responseBody?: BodyReference;
  responseHeaders: HeaderEntry[];
  serverIp?: string;
  summary: SessionSummary;
  timing?: TimingBreakdown;
};

export type StartProxyInput = {
  workspaceId: string;
  port?: number;
  enableSsl?: boolean;
};

export type StopProxyInput = {
  workspaceId: string;
};

export type CertificateStatus = {
  certPath?: string;
  fingerprint?: string;
  trusted: boolean;
  platform: "windows" | "macos" | "linux";
};

export type GenerateRootCertificateInput = {
  forceRegenerate?: boolean;
};

export type CertificateInstallGuide = {
  success: boolean;
  certPath: string;
  platform: string;
  steps: Array<{ order: number; description: string }>;
};

export type ComposedRequestInput = {
  workspaceId: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
};

export function isComposedRequestInput(value: unknown): value is ComposedRequestInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ComposedRequestInput>;
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(isHeaderEntry) &&
    (candidate.body === undefined || typeof candidate.body === "string")
  );
}

export function createMockComposeSessionDetail(input: ComposedRequestInput): SessionDetail {
  const now = new Date().toISOString();
  return {
    id: "mock-compose-" + Math.random().toString(36).slice(2, 10),
    summary: {
      id: "mock-compose-" + Math.random().toString(36).slice(2, 10),
      method: input.method,
      host: new URL(input.url).host,
      path: new URL(input.url).pathname,
      protocol: new URL(input.url).protocol.replace(":", ""),
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
    ...(input.body ? { requestBody: { inlineText: input.body, sizeBytes: input.body.length, mimeType: "text/plain" } as BodyReference } : {}),
    responseBody: {
      inlineText: JSON.stringify({ ok: true, method: input.method, url: input.url, mock: true }, null, 2),
      sizeBytes: 128,
      mimeType: "application/json",
    },
    timing: { totalMs: 42, waitingMs: 30, responseReadMs: 12 },
  };
}

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_PROXY_PORT = 8888;

export function createDefaultProxyStatus(): ProxyStatus {
  return {
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    port: DEFAULT_PROXY_PORT,
    running: false,
    sslEnabled: false,
    systemProxyEnabled: false,
  };
}

const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";
const UNKNOWN_ERROR_MESSAGE = "An unexpected error occurred.";

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

function isNullableBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === "boolean";
}

export function coerceAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: UNKNOWN_ERROR_CODE,
      message: error.message,
    };
  }

  return {
    code: UNKNOWN_ERROR_CODE,
    message: UNKNOWN_ERROR_MESSAGE,
    details: {
      receivedType: typeof error,
    },
  };
}

export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AppError>;

  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export function isProxyStatus(value: unknown): value is ProxyStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ProxyStatus> & {
    activeWorkspaceId?: string | null;
    startedAt?: string | null;
  };

  if (typeof candidate.running !== "boolean") {
    return false;
  }

  if (typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port <= 0) {
    return false;
  }

  if (typeof candidate.sslEnabled !== "boolean" || typeof candidate.systemProxyEnabled !== "boolean") {
    return false;
  }

  if (candidate.activeWorkspaceId !== undefined && candidate.activeWorkspaceId !== null && typeof candidate.activeWorkspaceId !== "string") {
    return false;
  }

  if (candidate.startedAt !== undefined && candidate.startedAt !== null && typeof candidate.startedAt !== "string") {
    return false;
  }

  return true;
}

export function parseProxyStatus(value: unknown): ProxyStatus {
  if (isProxyStatus(value)) {
    const candidate = value as ProxyStatus & {
      activeWorkspaceId?: string | null;
      startedAt?: string | null;
    };

    return {
      port: candidate.port,
      running: candidate.running,
      sslEnabled: candidate.sslEnabled,
      systemProxyEnabled: candidate.systemProxyEnabled,
      ...(candidate.activeWorkspaceId !== null && candidate.activeWorkspaceId !== undefined
        ? { activeWorkspaceId: candidate.activeWorkspaceId }
        : {}),
      ...(candidate.startedAt !== null && candidate.startedAt !== undefined
        ? { startedAt: candidate.startedAt }
        : {}),
    };
  }

  throw {
    code: "INVALID_PROXY_STATUS",
    message: "The proxy status payload does not match the shared contract.",
    details: {
      payload: value,
    },
  } satisfies AppError;
}

export function normalizeStartProxyInput(input: StartProxyInput): StartProxyInput {
  const normalizedPort = input.port ?? DEFAULT_PROXY_PORT;

  return {
    enableSsl: input.enableSsl ?? false,
    port: normalizedPort,
    workspaceId: input.workspaceId.trim(),
  };
}

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
    base64Text?: string | null;
    encoding?: string | null;
    inlineText?: string | null;
    mimeType?: string | null;
    truncated?: boolean | null;
  };

  return (
    typeof candidate.sizeBytes === "number" &&
    isNullableString(candidate.inlineText) &&
    isNullableString(candidate.base64Text) &&
    isNullableString(candidate.mimeType) &&
    isNullableString(candidate.encoding) &&
    isNullableBoolean(candidate.truncated)
  );
}

export function isTimingBreakdown(value: unknown): value is TimingBreakdown {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TimingBreakdown>;
  const timingFields = [
    candidate.connectMs,
    candidate.dnsMs,
    candidate.requestSendMs,
    candidate.responseReadMs,
    candidate.tlsMs,
    candidate.totalMs,
    candidate.waitingMs,
  ];

  return timingFields.every(isNullableNumber);
}

export function isSessionDetail(value: unknown): value is SessionDetail {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionDetail> & {
    rawRequest?: string | null;
    rawResponse?: string | null;
    requestBody?: BodyReference | null;
    responseBody?: BodyReference | null;
    serverIp?: string | null;
    timing?: TimingBreakdown | null;
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
    (candidate.requestBody === undefined || candidate.requestBody === null || isBodyReference(candidate.requestBody)) &&
    (candidate.responseBody === undefined || candidate.responseBody === null || isBodyReference(candidate.responseBody)) &&
    (candidate.timing === undefined || candidate.timing === null || isTimingBreakdown(candidate.timing)) &&
    isNullableString(candidate.rawRequest) &&
    isNullableString(candidate.rawResponse) &&
    isNullableString(candidate.serverIp)
  );
}

export function parseSessionDetail(value: unknown): SessionDetail {
  if (isSessionDetail(value)) {
    const candidate = value as SessionDetail & {
      rawRequest?: string | null;
      rawResponse?: string | null;
      requestBody?: BodyReference | null;
      responseBody?: BodyReference | null;
      serverIp?: string | null;
      timing?: TimingBreakdown | null;
    };

    return {
      cookies: candidate.cookies,
      id: candidate.id,
      queryParams: candidate.queryParams,
      requestHeaders: candidate.requestHeaders,
      responseHeaders: candidate.responseHeaders,
      summary: candidate.summary,
      ...(candidate.rawRequest !== null && candidate.rawRequest !== undefined
        ? { rawRequest: candidate.rawRequest }
        : {}),
      ...(candidate.rawResponse !== null && candidate.rawResponse !== undefined
        ? { rawResponse: candidate.rawResponse }
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
      ...(candidate.timing !== null && candidate.timing !== undefined
        ? { timing: normalizeTimingBreakdown(candidate.timing) }
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

function normalizeBodyReference(bodyReference: BodyReference & {
  base64Text?: string | null;
  encoding?: string | null;
  inlineText?: string | null;
  mimeType?: string | null;
  truncated?: boolean | null;
}): BodyReference {
  return {
    sizeBytes: bodyReference.sizeBytes,
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
    ...(bodyReference.truncated !== null && bodyReference.truncated !== undefined
      ? { truncated: bodyReference.truncated }
      : {}),
  };
}

function normalizeTimingBreakdown(timing: TimingBreakdown & {
  connectMs?: number | null;
  dnsMs?: number | null;
  requestSendMs?: number | null;
  responseReadMs?: number | null;
  tlsMs?: number | null;
  totalMs?: number | null;
  waitingMs?: number | null;
}): TimingBreakdown {
  return {
    ...(timing.connectMs !== null && timing.connectMs !== undefined ? { connectMs: timing.connectMs } : {}),
    ...(timing.dnsMs !== null && timing.dnsMs !== undefined ? { dnsMs: timing.dnsMs } : {}),
    ...(timing.requestSendMs !== null && timing.requestSendMs !== undefined
      ? { requestSendMs: timing.requestSendMs }
      : {}),
    ...(timing.responseReadMs !== null && timing.responseReadMs !== undefined
      ? { responseReadMs: timing.responseReadMs }
      : {}),
    ...(timing.tlsMs !== null && timing.tlsMs !== undefined ? { tlsMs: timing.tlsMs } : {}),
    ...(timing.totalMs !== null && timing.totalMs !== undefined ? { totalMs: timing.totalMs } : {}),
    ...(timing.waitingMs !== null && timing.waitingMs !== undefined ? { waitingMs: timing.waitingMs } : {}),
  };
}

export function isCertificateStatus(value: unknown): value is CertificateStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CertificateStatus> & {
    certPath?: string | null;
    fingerprint?: string | null;
  };
  if (typeof candidate.trusted !== "boolean") return false;
  if (typeof candidate.platform !== "string") return false;
  if (!["windows", "macos", "linux"].includes(candidate.platform)) return false;
  return true;
}

export function parseCertificateStatus(value: unknown): CertificateStatus {
  if (!isCertificateStatus(value)) {
    throw coerceAppError(value);
  }
  const candidate = value as CertificateStatus & {
    certPath?: string | null;
    fingerprint?: string | null;
  };
  return {
    trusted: candidate.trusted,
    platform: candidate.platform,
    ...(candidate.certPath !== null && candidate.certPath !== undefined
      ? { certPath: candidate.certPath }
      : {}),
    ...(candidate.fingerprint !== null && candidate.fingerprint !== undefined
      ? { fingerprint: candidate.fingerprint }
      : {}),
  };
}

export function isCertificateInstallGuide(value: unknown): value is CertificateInstallGuide {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CertificateInstallGuide>;
  return typeof candidate.success === "boolean" && Array.isArray(candidate.steps);
}

export function parseCertificateInstallGuide(value: unknown): CertificateInstallGuide {
  if (!isCertificateInstallGuide(value)) {
    throw coerceAppError(value);
  }
  return value as CertificateInstallGuide;
}

export function normalizeGenerateRootCertificateInput(
  input?: GenerateRootCertificateInput,
): GenerateRootCertificateInput {
  return {
    forceRegenerate: input?.forceRegenerate ?? false,
  };
}
