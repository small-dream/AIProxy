import { AppError, isNullableString } from "./common";

export type AiProviderType = "openai-compatible";

export type AiSettingsPublic = {
  provider: AiProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maskedApiKey?: string | undefined;
  temperature: number;
  timeoutMs: number;
  updatedAt?: string | undefined;
};

export type SaveAiSettingsInput = {
  provider: AiProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  clearApiKey?: boolean | undefined;
  temperature: number;
  timeoutMs: number;
};

export type TestAiConnectionResult = {
  ok: boolean;
  message: string;
};

export type SessionDiffChangeKind = "added" | "changed" | "removed" | "unchanged";

export type CompareMode = "request" | "session";

export type SessionDiffEntry = {
  path: string;
  kind: SessionDiffChangeKind;
  before?: string | undefined;
  after?: string | undefined;
};

export type SessionDiffSection = {
  key: string;
  title: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  entries: SessionDiffEntry[];
  canExpand?: boolean | undefined;
  note?: string | undefined;
  totalEntries?: number | undefined;
  truncated?: boolean | undefined;
  truncationReason?: string | undefined;
};

export type SessionDiffPayload = {
  compareMode: "request";
  left: {
    id: string;
    label: string;
    method: string;
    url: string;
    statusCode: number;
    durationMs: number;
    startedAt: string;
  };
  right: {
    id: string;
    label: string;
    method: string;
    url: string;
    statusCode: number;
    durationMs: number;
    startedAt: string;
  };
  sections: SessionDiffSection[];
  redacted: boolean;
  bodyIncluded: boolean;
};

export type SessionCompareScopeIdentity = {
  id: string;
  label: string;
  requestCount: number;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

export type SessionCompareOverview = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  domainCount: number;
  totalSizeBytes: number;
  statusCodes: Record<string, number>;
  durationMs: {
    min: number;
    max: number;
    average: number;
    total: number;
  };
};

export type SessionCompareDomainRow = {
  domain: string;
  leftCount: number;
  rightCount: number;
  delta: number;
  leftShare: number;
  rightShare: number;
};

export type SessionCompareEndpointRow = {
  endpoint: string;
  kind: "added" | "changed" | "removed" | "unchanged";
  leftCount: number;
  rightCount: number;
  delta: number;
  leftAverageDurationMs: number;
  rightAverageDurationMs: number;
  leftTotalDurationMs: number;
  rightTotalDurationMs: number;
  leftStatusCodes: Record<string, number>;
  rightStatusCodes: Record<string, number>;
};

export type SessionCompareTimelineBucket = {
  label: string;
  startedAt: string;
  leftCount: number;
  rightCount: number;
  delta: number;
};

export type SessionCompareSequenceMismatch = {
  index: number;
  left?: string | undefined;
  right?: string | undefined;
};

export type SessionComparePayload = {
  compareMode: "session";
  left: SessionCompareScopeIdentity;
  right: SessionCompareScopeIdentity;
  domainFilter: string[];
  generatedAt: string;
  redacted: boolean;
  bodyIncluded: false;
  overview: {
    left: SessionCompareOverview;
    right: SessionCompareOverview;
  };
  domains: SessionCompareDomainRow[];
  endpoints: SessionCompareEndpointRow[];
  timeline: {
    bucketMs: number;
    buckets: SessionCompareTimelineBucket[];
  };
  sequence: {
    left: string[];
    right: string[];
    addedEndpoints: string[];
    removedEndpoints: string[];
    changedPositions: SessionCompareSequenceMismatch[];
    repeatedEndpoints: Array<{
      endpoint: string;
      leftCount: number;
      rightCount: number;
    }>;
  };
};

export type CompareAiPayload = SessionDiffPayload | SessionComparePayload;

export type SessionDiffSummaryRequest = {
  payload: CompareAiPayload;
  language: "en" | "zh-CN";
};

export type SessionDiffSummaryResult = {
  summary: string;
  model: string;
  provider: AiProviderType;
  createdAt: string;
};

export function isAiProviderType(value: unknown): value is AiProviderType {
  return value === "openai-compatible";
}

export function isAiSettingsPublic(value: unknown): value is AiSettingsPublic {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AiSettingsPublic>;

  return (
    isAiProviderType(candidate.provider) &&
    typeof candidate.baseUrl === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.hasApiKey === "boolean" &&
    isNullableString(candidate.maskedApiKey) &&
    typeof candidate.temperature === "number" &&
    typeof candidate.timeoutMs === "number" &&
    isNullableString(candidate.updatedAt)
  );
}

export function parseAiSettingsPublic(value: unknown): AiSettingsPublic {
  if (isAiSettingsPublic(value)) {
    return value;
  }

  throw {
    code: "INVALID_AI_SETTINGS",
    message: "The AI settings payload does not match the shared contract.",
    details: { payload: value },
  } satisfies AppError;
}

export function isTestAiConnectionResult(value: unknown): value is TestAiConnectionResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TestAiConnectionResult>;

  return typeof candidate.ok === "boolean" && typeof candidate.message === "string";
}

export function parseTestAiConnectionResult(value: unknown): TestAiConnectionResult {
  if (isTestAiConnectionResult(value)) {
    return value;
  }

  throw {
    code: "INVALID_AI_TEST_RESULT",
    message: "The AI connection test payload does not match the shared contract.",
    details: { payload: value },
  } satisfies AppError;
}

export function isSessionDiffSummaryResult(value: unknown): value is SessionDiffSummaryResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionDiffSummaryResult>;

  return (
    typeof candidate.summary === "string" &&
    typeof candidate.model === "string" &&
    isAiProviderType(candidate.provider) &&
    typeof candidate.createdAt === "string"
  );
}

export function parseSessionDiffSummaryResult(value: unknown): SessionDiffSummaryResult {
  if (isSessionDiffSummaryResult(value)) {
    return value;
  }

  throw {
    code: "INVALID_AI_SUMMARY_RESULT",
    message: "The AI summary payload does not match the shared contract.",
    details: { payload: value },
  } satisfies AppError;
}

export function isSaveAiSettingsInput(value: unknown): value is SaveAiSettingsInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SaveAiSettingsInput>;

  return (
    isAiProviderType(candidate.provider) &&
    typeof candidate.baseUrl === "string" &&
    typeof candidate.model === "string" &&
    isNullableString(candidate.apiKey) &&
    (candidate.clearApiKey === undefined || typeof candidate.clearApiKey === "boolean") &&
    typeof candidate.temperature === "number" &&
    typeof candidate.timeoutMs === "number"
  );
}
