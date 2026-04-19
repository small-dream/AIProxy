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

export type AndroidAdbCertificateInstallResult = {
  success: boolean;
  deviceSerial: string;
  remotePath: string;
};

export type AndroidAdbProxyResult = {
  success: boolean;
  deviceSerial: string;
  proxyAddress?: string;
};

export type AndroidAdbDevice = {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
};

export type IOSSimulatorDevice = {
  name: string;
  udid: string;
  state: string;
  runtime: string;
};

export type InstallAndroidCertificateViaAdbInput = {
  deviceSerial?: string;
};

export type SetAndroidProxyViaAdbInput = {
  deviceSerial?: string;
  host: string;
  port: number;
};

export type ClearAndroidProxyViaAdbInput = {
  deviceSerial?: string;
};

export type InstallIosCertificateViaSimulatorInput = {
  simulatorUdid?: string;
};

export type IOSSimulatorCertificateInstallResult = {
  success: boolean;
  simulatorName: string;
  simulatorUdid: string;
};

export type ComposedRequestInput = {
  workspaceId: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
};

// ---------------------------------------------------------------------------
// Breakpoint types
// ---------------------------------------------------------------------------

export type BreakpointStage = "request" | "response";

export type BreakpointActionKind = "forward" | "drop" | "mock";

export type MockResponse = {
  statusCode: number;
  headers: HeaderEntry[];
  bodyBase64?: string;
};

export type BreakpointRule = {
  id: string;
  enabled: boolean;
  urlPattern: string;
  methods: string[];
  stage: BreakpointStage;
};

export type BreakpointHit = {
  sessionId: string;
  stage: BreakpointStage;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: HeaderEntry[];
  requestBody?: BodyReference;
  responseStatusCode?: number;
  responseHeaders?: HeaderEntry[];
  responseBody?: BodyReference;
};

export type BreakpointResolution = {
  sessionId: string;
  action: BreakpointActionKind;
  mock?: MockResponse;
  modifiedRequestHeaders?: HeaderEntry[];
  modifiedRequestBodyBase64?: string;
  modifiedResponseHeaders?: HeaderEntry[];
  modifiedResponseBodyBase64?: string;
};

export type RuleMatchStage = "request" | "response" | "either";

export type RuleMatch = {
  urlPattern: string;
  methods: string[];
  stage: RuleMatchStage;
};

export type RewriteRuleType = "header" | "query" | "body" | "redirect";

export type RewriteTarget = "request" | "response";

export type RewriteHeaderPayload = {
  headerName: string;
  operation: "set" | "remove";
  target: RewriteTarget;
  value?: string;
};

export type RewriteQueryPayload = {
  operation: "set" | "remove";
  paramName: string;
  value?: string;
};

export type RewriteBodyPayload = {
  contentType: string;
  target: RewriteTarget;
  text: string;
};

export type RewriteRedirectPayload = {
  preservePath: boolean;
  preserveQuery: boolean;
  targetUrl: string;
};

type RewriteRuleBase = {
  enabled: boolean;
  id: string;
  match: RuleMatch;
  name: string;
  note?: string;
  priority: number;
  workspaceId: string;
};

export type RewriteRule =
  | (RewriteRuleBase & {
      payload: RewriteHeaderPayload;
      rewriteType: "header";
    })
  | (RewriteRuleBase & {
      payload: RewriteQueryPayload;
      rewriteType: "query";
    })
  | (RewriteRuleBase & {
      payload: RewriteBodyPayload;
      rewriteType: "body";
    })
  | (RewriteRuleBase & {
      payload: RewriteRedirectPayload;
      rewriteType: "redirect";
    });

export type MapRuleMode = "local" | "remote";

export type MapRule = {
  enabled: boolean;
  id: string;
  mode: MapRuleMode;
  name: string;
  note?: string;
  preservePath: boolean;
  preserveQuery: boolean;
  priority: number;
  sourcePattern: string;
  targetValue: string;
  workspaceId: string;
};

export type ThrottleProfile = {
  downloadKbps: number;
  enabled: boolean;
  id: string;
  latencyMs: number;
  name: string;
  note?: string;
  packetLossRatio: number;
  preset: boolean;
  uploadKbps: number;
  workspaceId: string;
};

export type ExportFormat = "har" | "curl" | "json";
export type ExportScope = "selected" | "filtered" | "all";

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

export function isAndroidAdbCertificateInstallResult(
  value: unknown,
): value is AndroidAdbCertificateInstallResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbCertificateInstallResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.deviceSerial === "string" &&
    typeof candidate.remotePath === "string"
  );
}

export function parseAndroidAdbCertificateInstallResult(
  value: unknown,
): AndroidAdbCertificateInstallResult {
  if (!isAndroidAdbCertificateInstallResult(value)) {
    throw coerceAppError(value);
  }
  return value;
}

export function isAndroidAdbProxyResult(value: unknown): value is AndroidAdbProxyResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbProxyResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.deviceSerial === "string" &&
    isNullableString(candidate.proxyAddress)
  );
}

export function parseAndroidAdbProxyResult(value: unknown): AndroidAdbProxyResult {
  if (!isAndroidAdbProxyResult(value)) {
    throw coerceAppError(value);
  }

  const candidate = value as AndroidAdbProxyResult & {
    proxyAddress?: string | null;
  };

  return {
    success: candidate.success,
    deviceSerial: candidate.deviceSerial,
    ...(candidate.proxyAddress !== null && candidate.proxyAddress !== undefined
      ? { proxyAddress: candidate.proxyAddress }
      : {}),
  };
}

export function isAndroidAdbDevice(value: unknown): value is AndroidAdbDevice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbDevice>;
  return (
    typeof candidate.serial === "string" &&
    typeof candidate.state === "string" &&
    isNullableString(candidate.model) &&
    isNullableString(candidate.product) &&
    isNullableString(candidate.device) &&
    isNullableString(candidate.transportId)
  );
}

export function parseAndroidAdbDevices(value: unknown): AndroidAdbDevice[] {
  if (!Array.isArray(value) || !value.every(isAndroidAdbDevice)) {
    throw coerceAppError(value);
  }

  return value.map((device) => ({
    serial: device.serial,
    state: device.state,
    ...(device.model !== null && device.model !== undefined ? { model: device.model } : {}),
    ...(device.product !== null && device.product !== undefined ? { product: device.product } : {}),
    ...(device.device !== null && device.device !== undefined ? { device: device.device } : {}),
    ...(device.transportId !== null && device.transportId !== undefined
      ? { transportId: device.transportId }
      : {}),
  }));
}

export function isIOSSimulatorDevice(value: unknown): value is IOSSimulatorDevice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IOSSimulatorDevice>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.udid === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.runtime === "string"
  );
}

export function parseIOSSimulatorDevices(value: unknown): IOSSimulatorDevice[] {
  if (!Array.isArray(value) || !value.every(isIOSSimulatorDevice)) {
    throw coerceAppError(value);
  }

  return value.map((device) => ({
    name: device.name,
    udid: device.udid,
    state: device.state,
    runtime: device.runtime,
  }));
}

export function isIOSSimulatorCertificateInstallResult(
  value: unknown,
): value is IOSSimulatorCertificateInstallResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IOSSimulatorCertificateInstallResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.simulatorName === "string" &&
    typeof candidate.simulatorUdid === "string"
  );
}

export function parseIOSSimulatorCertificateInstallResult(
  value: unknown,
): IOSSimulatorCertificateInstallResult {
  if (!isIOSSimulatorCertificateInstallResult(value)) {
    throw coerceAppError(value);
  }

  return value;
}

export function normalizeGenerateRootCertificateInput(
  input?: GenerateRootCertificateInput,
): GenerateRootCertificateInput {
  return {
    forceRegenerate: input?.forceRegenerate ?? false,
  };
}

// ---------------------------------------------------------------------------
// Breakpoint type guards
// ---------------------------------------------------------------------------

export function isBreakpointHit(value: unknown): value is BreakpointHit {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakpointHit>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.stage === "request" || candidate.stage === "response") &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.path === "string" &&
    Array.isArray(candidate.requestHeaders) &&
    candidate.requestHeaders.every(isHeaderEntry)
  );
}

export function parseBreakpointHit(value: unknown): BreakpointHit {
  if (!isBreakpointHit(value)) {
    throw coerceAppError(value);
  }
  const candidate = value as BreakpointHit & {
    requestBody?: BodyReference | null;
    responseStatusCode?: number | null;
    responseHeaders?: HeaderEntry[] | null;
    responseBody?: BodyReference | null;
  };
  return {
    sessionId: candidate.sessionId,
    stage: candidate.stage,
    method: candidate.method,
    url: candidate.url,
    host: candidate.host,
    path: candidate.path,
    requestHeaders: candidate.requestHeaders,
    ...(candidate.requestBody !== null && candidate.requestBody !== undefined
      ? { requestBody: normalizeBodyReference(candidate.requestBody as BodyReference & Record<string, unknown>) }
      : {}),
    ...(candidate.responseStatusCode !== null && candidate.responseStatusCode !== undefined
      ? { responseStatusCode: candidate.responseStatusCode }
      : {}),
    ...(candidate.responseHeaders !== null && candidate.responseHeaders !== undefined
      ? { responseHeaders: candidate.responseHeaders }
      : {}),
    ...(candidate.responseBody !== null && candidate.responseBody !== undefined
      ? { responseBody: normalizeBodyReference(candidate.responseBody as BodyReference & Record<string, unknown>) }
      : {}),
  };
}

export function isBreakpointRule(value: unknown): value is BreakpointRule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakpointRule>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.urlPattern === "string" &&
    Array.isArray(candidate.methods) &&
    (candidate.stage === "request" || candidate.stage === "response")
  );
}

export function parseBreakpointRules(value: unknown): BreakpointRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }
  if (value.every(isBreakpointRule)) {
    return value;
  }
  throw coerceAppError(value);
}

export function isRuleMatch(value: unknown): value is RuleMatch {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<RuleMatch>;

  return (
    typeof candidate.urlPattern === "string" &&
    Array.isArray(candidate.methods) &&
    candidate.methods.every((method) => typeof method === "string") &&
    (candidate.stage === "request" || candidate.stage === "response" || candidate.stage === "either")
  );
}

function isRewriteHeaderPayload(value: unknown): value is RewriteHeaderPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteHeaderPayload>;
  return (
    typeof candidate.headerName === "string" &&
    (candidate.operation === "set" || candidate.operation === "remove") &&
    (candidate.target === "request" || candidate.target === "response") &&
    isNullableString(candidate.value)
  );
}

function isRewriteQueryPayload(value: unknown): value is RewriteQueryPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteQueryPayload>;
  return (
    typeof candidate.paramName === "string" &&
    (candidate.operation === "set" || candidate.operation === "remove") &&
    isNullableString(candidate.value)
  );
}

function isRewriteBodyPayload(value: unknown): value is RewriteBodyPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteBodyPayload>;
  return (
    typeof candidate.contentType === "string" &&
    typeof candidate.text === "string" &&
    (candidate.target === "request" || candidate.target === "response")
  );
}

function isRewriteRedirectPayload(value: unknown): value is RewriteRedirectPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RewriteRedirectPayload>;
  return (
    typeof candidate.targetUrl === "string" &&
    typeof candidate.preservePath === "boolean" &&
    typeof candidate.preserveQuery === "boolean"
  );
}

export function isRewriteRule(value: unknown): value is RewriteRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<RewriteRule>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.priority !== "number" ||
    !isNullableString(candidate.note) ||
    !isRuleMatch(candidate.match)
  ) {
    return false;
  }

  if (candidate.rewriteType === "header") {
    return isRewriteHeaderPayload(candidate.payload);
  }

  if (candidate.rewriteType === "query") {
    return isRewriteQueryPayload(candidate.payload);
  }

  if (candidate.rewriteType === "body") {
    return isRewriteBodyPayload(candidate.payload);
  }

  if (candidate.rewriteType === "redirect") {
    return isRewriteRedirectPayload(candidate.payload);
  }

  return false;
}

export function parseRewriteRules(value: unknown): RewriteRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isRewriteRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function isMapRule(value: unknown): value is MapRule {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<MapRule>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    (candidate.mode === "local" || candidate.mode === "remote") &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.priority === "number" &&
    typeof candidate.sourcePattern === "string" &&
    typeof candidate.targetValue === "string" &&
    typeof candidate.preservePath === "boolean" &&
    typeof candidate.preserveQuery === "boolean" &&
    isNullableString(candidate.note)
  );
}

export function parseMapRules(value: unknown): MapRule[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isMapRule)) {
    return value;
  }

  throw coerceAppError(value);
}

export function isThrottleProfile(value: unknown): value is ThrottleProfile {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<ThrottleProfile>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.latencyMs === "number" &&
    typeof candidate.uploadKbps === "number" &&
    typeof candidate.downloadKbps === "number" &&
    typeof candidate.packetLossRatio === "number" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.preset === "boolean" &&
    isNullableString(candidate.note)
  );
}

export function parseThrottleProfiles(value: unknown): ThrottleProfile[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isThrottleProfile)) {
    return value;
  }

  throw coerceAppError(value);
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<Workspace>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.proxyPort === "number" &&
    typeof candidate.sslEnabled === "boolean" &&
    typeof candidate.systemProxyEnabled === "boolean" &&
    typeof candidate.storagePath === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function parseWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }

  if (value.every(isWorkspace)) {
    return value;
  }

  throw coerceAppError(value);
}

export function parseWorkspace(value: unknown): Workspace {
  if (isWorkspace(value)) {
    return value;
  }

  throw coerceAppError(value);
}

// ---------------------------------------------------------------------------
// WebSocket message types
// ---------------------------------------------------------------------------

export type WsMessageDirection = "clientToServer" | "serverToClient";
export type WsOpcode = "text" | "binary" | "close" | "ping" | "pong" | "continuation";

export type WsMessage = {
  id: string;
  sessionId: string;
  direction: WsMessageDirection;
  timestamp: string;
  opcode: WsOpcode;
  payloadText?: string;
  payloadSize: number;
  fin: boolean;
};

export function isWsMessage(value: unknown): value is WsMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WsMessage>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    (candidate.direction === "clientToServer" || candidate.direction === "serverToClient") &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.opcode === "string" &&
    typeof candidate.payloadSize === "number" &&
    typeof candidate.fin === "boolean" &&
    isNullableString(candidate.payloadText)
  );
}

export function parseWsMessages(value: unknown): WsMessage[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }
  if (value.every(isWsMessage)) {
    return value;
  }
  throw coerceAppError(value);
}
