import type {
  HeaderEntry,
  SessionDetail,
  SessionDiffEntry,
  SessionDiffPayload,
  SessionDiffSection,
  SessionSummary,
  TimingBreakdown,
} from "@aiproxy/shared-types";

import { redactDiffPayload } from "./redaction.helpers";

const MAX_ENTRY_VALUE_LENGTH = 2_000;
const MAX_BODY_ENTRIES_FOR_AI = 80;
const DEFAULT_BODY_DIFF_CHAR_GUARD = 256_000;

export type CompareBuildOptions = {
  bodyDiffMode?: "diff" | "summary";
  expandedBodySections?: Iterable<string>;
  includeBodyForAi: boolean;
  maxBodyCharsForDiff?: number;
  maxBodyEntries?: number;
  redact: boolean;
};

export function buildSessionDiffPayload(
  left: SessionDetail,
  right: SessionDetail,
  options: CompareBuildOptions,
): SessionDiffPayload {
  const sections = [
    diffSummary(left.summary, right.summary),
    diffEntries("query", "Query", left.queryParams, right.queryParams),
    diffEntries("requestHeaders", "Request Headers", left.requestHeaders, right.requestHeaders),
    diffBody("requestBody", "Request Body", left.requestBody, right.requestBody, options),
    diffEntries("responseHeaders", "Response Headers", left.responseHeaders, right.responseHeaders),
    diffBody("responseBody", "Response Body", left.responseBody, right.responseBody, options),
    diffTiming(left.timing, right.timing),
  ];

  const payload: SessionDiffPayload = {
    compareMode: "request",
    left: summaryIdentity(left.summary),
    right: summaryIdentity(right.summary),
    sections,
    redacted: false,
    bodyIncluded: options.includeBodyForAi,
  };

  return options.redact ? redactDiffPayload(payload) : payload;
}

export function getBodyText(body: SessionDetail["requestBody"] | SessionDetail["responseBody"]): string | undefined {
  return body?.inlineText ?? body?.base64Text;
}

function summaryIdentity(summary: SessionSummary) {
  return {
    id: summary.id,
    label: `${summary.method} ${summary.host}${summary.path}`,
    method: summary.method,
    url: summary.url,
    statusCode: summary.statusCode,
    durationMs: summary.durationMs,
    startedAt: summary.startedAt,
  };
}

function diffSummary(left: SessionSummary, right: SessionSummary): SessionDiffSection {
  const entries: SessionDiffEntry[] = [
    compareScalar("Method", left.method, right.method),
    compareScalar("URL", left.url, right.url),
    compareScalar("Status", String(left.statusCode), String(right.statusCode)),
    compareScalar("Duration", `${left.durationMs} ms`, `${right.durationMs} ms`),
    compareScalar("Size", `${left.sizeBytes} bytes`, `${right.sizeBytes} bytes`),
    compareScalar("Protocol", left.protocol, right.protocol),
    compareScalar("MIME", left.responseMimeType ?? "", right.responseMimeType ?? ""),
  ];

  return buildSection("summary", "Summary", entries);
}

function diffTiming(left: TimingBreakdown | undefined, right: TimingBreakdown | undefined): SessionDiffSection {
  const keys: Array<keyof TimingBreakdown> = [
    "dnsMs",
    "connectMs",
    "tlsMs",
    "requestSendMs",
    "waitingMs",
    "responseReadMs",
    "totalMs",
  ];
  const entries = keys.map((key) =>
    compareScalar(key, formatTimingValue(left?.[key]), formatTimingValue(right?.[key])),
  );

  return buildSection("timing", "Timing", entries);
}

function formatTimingValue(value: number | undefined) {
  return value === undefined ? "" : `${value} ms`;
}

function diffEntries(
  key: string,
  title: string,
  leftEntries: HeaderEntry[],
  rightEntries: HeaderEntry[],
): SessionDiffSection {
  const leftMap = collectEntries(leftEntries);
  const rightMap = collectEntries(rightEntries);
  const names = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort();
  const entries = names.map((name) => {
    const before = leftMap.get(name);
    const after = rightMap.get(name);
    if (before === undefined) {
      return { path: name, kind: "added" as const, after: truncateValue(after) };
    }
    if (after === undefined) {
      return { path: name, kind: "removed" as const, before: truncateValue(before) };
    }
    return {
      path: name,
      kind: before === after ? "unchanged" as const : "changed" as const,
      before: truncateValue(before),
      after: truncateValue(after),
    };
  });

  return buildSection(key, title, entries);
}

function collectEntries(entries: HeaderEntry[]) {
  const map = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), entry.value]);
  }
  return new Map(Array.from(map.entries()).map(([key, values]) => [key, values.join("\n")]));
}

function diffBody(
  key: string,
  title: string,
  leftBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
  rightBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
  options: CompareBuildOptions,
): SessionDiffSection {
  const leftBodyText = getBodyText(leftBody);
  const rightBodyText = getBodyText(rightBody);
  const metadataEntries = diffBodyMetadata(leftBody, rightBody);

  if (!leftBody && !rightBody) {
    return buildSection(key, title, [], "No body captured on either side.");
  }

  if (!options.includeBodyForAi) {
    return buildSection(
      key,
      title,
      metadataEntries,
      "Body context is excluded from the AI payload.",
    );
  }

  if (!leftBodyText && !rightBodyText) {
    return buildSection(
      key,
      title,
      metadataEntries,
      "Body is captured but is not available as renderable text, so text diff is unavailable.",
    );
  }

  const expandedBodySections = new Set(options.expandedBodySections ?? []);
  const bodyDiffMode = options.bodyDiffMode ?? "diff";
  if (bodyDiffMode === "summary" && !expandedBodySections.has(key)) {
    return buildSection(
      key,
      title,
      metadataEntries,
      "Body detail is collapsed. Expand to compute a bounded text or JSON diff.",
      { canExpand: true },
    );
  }

  const totalBodyChars = (leftBodyText?.length ?? 0) + (rightBodyText?.length ?? 0);
  const maxBodyChars = options.maxBodyCharsForDiff ?? DEFAULT_BODY_DIFF_CHAR_GUARD;
  if (totalBodyChars > maxBodyChars) {
    return buildSection(
      key,
      title,
      metadataEntries,
      `Detailed body diff skipped because the captured text is ${formatNumber(totalBodyChars)} chars, above the ${formatNumber(maxBodyChars)} char guard.`,
      { truncated: true, truncationReason: "Body diff skipped by size guard." },
    );
  }

  const entryLimit = options.maxBodyEntries ?? MAX_BODY_ENTRIES_FOR_AI;
  const leftJson = parseJson(leftBodyText);
  const rightJson = parseJson(rightBodyText);
  const entries = leftJson.ok && rightJson.ok
    ? diffJsonValues("$", leftJson.value, rightJson.value)
    : diffTextLines(leftBodyText ?? "", rightBodyText ?? "");

  if (leftJson.ok && rightJson.ok) {
    const truncated = entries.length > entryLimit;
    return buildSection(
      key,
      title,
      entries.slice(0, entryLimit),
      buildBodyNote(leftBody, rightBody),
      {
        counts: countEntries(entries),
        totalEntries: entries.length,
        truncated,
        ...(truncated ? { truncationReason: `Showing the first ${entryLimit} body diff entries.` } : {}),
      },
    );
  }

  const truncated = entries.length > entryLimit;
  return buildSection(
    key,
    title,
    entries.slice(0, entryLimit),
    buildBodyNote(leftBody, rightBody),
    {
      counts: countEntries(entries),
      totalEntries: entries.length,
      truncated,
      ...(truncated ? { truncationReason: `Showing the first ${entryLimit} body diff entries.` } : {}),
    },
  );
}

function diffBodyMetadata(
  leftBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
  rightBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
): SessionDiffEntry[] {
  return [
    compareScalar("body.sizeBytes", describeBodySize(leftBody), describeBodySize(rightBody)),
    compareScalar("body.mimeType", leftBody?.mimeType ?? "", rightBody?.mimeType ?? ""),
    compareScalar("body.encoding", leftBody?.encoding ?? "", rightBody?.encoding ?? ""),
    compareScalar("body.text", describeTextAvailability(leftBody), describeTextAvailability(rightBody)),
    compareScalar("body.truncated", describeBoolean(leftBody?.truncated), describeBoolean(rightBody?.truncated)),
  ];
}

function describeBodySize(body: SessionDetail["requestBody"] | SessionDetail["responseBody"]) {
  return body ? `${body.sizeBytes} bytes` : "No body";
}

function describeTextAvailability(body: SessionDetail["requestBody"] | SessionDetail["responseBody"]) {
  if (!body) {
    return "No body";
  }
  if (getBodyText(body)) {
    return "Text available";
  }
  if (body.textDeferred) {
    return "Text deferred";
  }
  return "Non-text or binary";
}

function describeBoolean(value: boolean | undefined) {
  return value === undefined ? "" : String(value);
}

function buildBodyNote(
  leftBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
  rightBody: SessionDetail["requestBody"] | SessionDetail["responseBody"],
) {
  return leftBody?.truncated || rightBody?.truncated
    ? "One or both captured bodies were truncated by the proxy."
    : undefined;
}

function parseJson(value: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!value?.trim()) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function diffJsonValues(path: string, left: unknown, right: unknown): SessionDiffEntry[] {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return [{ path, kind: "unchanged", before: stringifyValue(left), after: stringifyValue(right) }];
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    return keys.flatMap((key) => {
      const nextPath = `${path}.${key}`;
      if (!(key in left)) return [{ path: nextPath, kind: "added" as const, after: stringifyValue(right[key]) }];
      if (!(key in right)) return [{ path: nextPath, kind: "removed" as const, before: stringifyValue(left[key]) }];
      return diffJsonValues(nextPath, left[key], right[key]);
    });
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => {
      const nextPath = `${path}[${index}]`;
      if (index >= left.length) return [{ path: nextPath, kind: "added" as const, after: stringifyValue(right[index]) }];
      if (index >= right.length) return [{ path: nextPath, kind: "removed" as const, before: stringifyValue(left[index]) }];
      return diffJsonValues(nextPath, left[index], right[index]);
    }).flat();
  }

  return [{
    path,
    kind: "changed",
    before: stringifyValue(left),
    after: stringifyValue(right),
  }];
}

function diffTextLines(left: string, right: string): SessionDiffEntry[] {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const length = Math.max(leftLines.length, rightLines.length);

  return Array.from({ length }, (_, index) => {
    const before = leftLines[index];
    const after = rightLines[index];
    if (before === undefined) return { path: `line ${index + 1}`, kind: "added" as const, after: truncateValue(after) };
    if (after === undefined) return { path: `line ${index + 1}`, kind: "removed" as const, before: truncateValue(before) };
    return {
      path: `line ${index + 1}`,
      kind: before === after ? "unchanged" as const : "changed" as const,
      before: truncateValue(before),
      after: truncateValue(after),
    };
  }).filter((entry) => entry.kind !== "unchanged" || entry.before);
}

function compareScalar(path: string, before: string, after: string): SessionDiffEntry {
  return {
    path,
    kind: before === after ? "unchanged" : "changed",
    before: truncateValue(before),
    after: truncateValue(after),
  };
}

function buildSection(
  key: string,
  title: string,
  entries: SessionDiffEntry[],
  note?: string,
  metadata: {
    canExpand?: boolean;
    counts?: {
      added: number;
      changed: number;
      removed: number;
      unchanged: number;
    };
    totalEntries?: number;
    truncated?: boolean;
    truncationReason?: string;
  } = {},
): SessionDiffSection {
  return {
    key,
    title,
    ...countEntries(entries, metadata.counts),
    entries,
    ...(metadata.canExpand !== undefined ? { canExpand: metadata.canExpand } : {}),
    ...(note ? { note } : {}),
    ...(metadata.totalEntries !== undefined ? { totalEntries: metadata.totalEntries } : {}),
    ...(metadata.truncated !== undefined ? { truncated: metadata.truncated } : {}),
    ...(metadata.truncationReason ? { truncationReason: metadata.truncationReason } : {}),
  };
}

function countEntries(
  entries: SessionDiffEntry[],
  override?: { added: number; changed: number; removed: number; unchanged: number },
) {
  if (override) {
    return override;
  }

  return {
    added: entries.filter((entry) => entry.kind === "added").length,
    removed: entries.filter((entry) => entry.kind === "removed").length,
    changed: entries.filter((entry) => entry.kind === "changed").length,
    unchanged: entries.filter((entry) => entry.kind === "unchanged").length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown) {
  return truncateValue(typeof value === "string" ? value : JSON.stringify(value));
}

function truncateValue(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value.length > MAX_ENTRY_VALUE_LENGTH
    ? `${value.slice(0, MAX_ENTRY_VALUE_LENGTH)}...`
    : value;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
