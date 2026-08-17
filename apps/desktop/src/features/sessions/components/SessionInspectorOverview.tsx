import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, ButtonBase, Stack, Tooltip, Typography } from "@mui/material";
import type {
  BodyReference,
  HeaderEntry,
  SessionDetail,
  SessionSummary,
} from "@aiproxy/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "@/i18n";
import {
  INSPECTOR_KEY_VALUE_GRID_TEMPLATE,
  InspectorScrollArea,
  inspectorKeyTypographySx,
  inspectorValueTypographySx,
} from "./SessionInspectorShared";
import {
  formatSessionProtocol,
  getSessionProtocolMetadata,
} from "@/features/sessions/session-protocol.helpers";
import { formatTiming, isClientCancelledStatus } from "./session-inspector.helpers";
import { WaterfallChart } from "./WaterfallChart";

type OverviewSection = {
  key: string;
  title: string;
  items: Array<[string, string]>;
};

type OverviewSizeGroup = {
  key: string;
  title: string;
  total: string;
  items: Array<[string, string]>;
};

type OverviewSizeBreakdown = {
  title: string;
  groups: OverviewSizeGroup[];
  total: [string, string];
};

type OverviewBlock = {
  key: string;
  title: string;
  content: ReactNode;
};

export function SessionInspectorOverview({
  detail,
  leading,
  session,
}: {
  detail: SessionDetail | undefined;
  leading?: ReactNode;
  session: SessionSummary;
}) {
  const { t } = useI18n();
  const { sections, sizeBreakdown } = useMemo(
    () =>
      buildOverviewSections({
        detail,
        session,
        t,
      }),
    [detail, session, t],
  );
  const overviewBlocks = useMemo<OverviewBlock[]>(
    () => [
      ...sections.map((section) => ({
        key: section.key,
        title: section.title,
        content: (
          <Stack spacing={0}>
            {section.key === "timing" ? (
              <Box sx={{ mb: 0.75, pl: 3.25 }}>
                <WaterfallChart timing={detail?.timing} />
              </Box>
            ) : null}
            <OverviewDefinitionList
              indent={section.key === "general" ? 0 : 3.25}
              items={section.items}
            />
          </Stack>
        ),
      })),
      {
        key: "size",
        title: sizeBreakdown.title,
        content: (
          <OverviewSizeTree
            sessionId={session.id}
            showTitle={false}
            sizeBreakdown={sizeBreakdown}
          />
        ),
      },
    ],
    [sections, session.id, sizeBreakdown, detail?.timing],
  );
  const initialExpandedBlocks = useMemo(
    () => buildExpandedState(["general", "timing", "size"]),
    [],
  );
  const [expandedBlocks, setExpandedBlocks] =
    useState<Record<string, boolean>>(initialExpandedBlocks);

  useEffect(() => {
    setExpandedBlocks(initialExpandedBlocks);
  }, [initialExpandedBlocks, session.id]);

  return (
    <InspectorScrollArea>
      <Stack spacing={0} sx={{ pb: 1, pt: 0.25 }}>
        {leading ? (
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            {leading}
          </Stack>
        ) : null}
        <Stack spacing={0}>
          {overviewBlocks.map((block) => {
            const isExpanded = expandedBlocks[block.key] ?? true;
            const isGeneral = block.key === "general";

            return (
              <Stack key={block.key} spacing={0}>
                {isGeneral ? null : (
                  <OverviewTreeHeader
                    expanded={isExpanded}
                    onClick={() => {
                      setExpandedBlocks((current) => ({
                        ...current,
                        [block.key]: !isExpanded,
                      }));
                    }}
                    title={block.title}
                  />
                )}

                {isExpanded ? (
                  <Box
                    sx={{
                      pb: isGeneral ? 0.5 : 0.75,
                      pt: isGeneral ? 0.25 : 0.25,
                    }}
                  >
                    {block.content}
                  </Box>
                ) : null}
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </InspectorScrollArea>
  );
}

function OverviewTreeHeader({
  expanded,
  indent = 0,
  onClick,
  title,
  value,
}: {
  expanded: boolean;
  indent?: number;
  onClick: () => void;
  title: string;
  value?: string | undefined;
}) {
  return (
    <ButtonBase
      aria-expanded={expanded}
      disableRipple
      onClick={onClick}
      sx={{
        display: "block",
        textAlign: "left",
        width: "100%",
      }}
    >
      <OverviewGridRow
        label={
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              alignItems: "center",
            }}
          >
            {expanded ? (
              <ExpandMoreRoundedIcon sx={{ color: "text.disabled", fontSize: 17 }} />
            ) : (
              <ChevronRightRoundedIcon sx={{ color: "text.disabled", fontSize: 17 }} />
            )}
            <Typography sx={{ ...inspectorValueTypographySx, fontWeight: 600 }} variant="body2">
              {title}
            </Typography>
          </Stack>
        }
        labelIndent={indent}
        value={value}
      />
    </ButtonBase>
  );
}

function OverviewDefinitionList({
  indent = 0,
  items,
}: {
  indent?: number;
  items: Array<[string, string]>;
}) {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <Typography sx={inspectorKeyTypographySx} variant="body2">
        {t("common.empty.noData")}
      </Typography>
    );
  }

  return (
    <Stack spacing={0}>
      {items.map(([label, value]) => (
        <OverviewGridRow
          key={`${label}:${value}`}
          label={
            <Typography sx={inspectorKeyTypographySx} variant="body2">
              {label}
            </Typography>
          }
          labelIndent={indent}
          value={value}
        />
      ))}
    </Stack>
  );
}

function OverviewGridRow({
  label,
  labelIndent = 0,
  value,
}: {
  label: ReactNode;
  labelIndent?: number;
  value?: string | undefined;
}) {
  return (
    <Box
      sx={{
        alignItems: "center",
        columnGap: 3,
        display: "grid",
        gridTemplateColumns: INSPECTOR_KEY_VALUE_GRID_TEMPLATE,
        minHeight: 30,
      }}
    >
      <Box sx={{ minWidth: 0, pl: labelIndent }}>{label}</Box>
      {value !== undefined ? <OverviewValueCell value={value} /> : <Box />}
    </Box>
  );
}

function OverviewValueCell({ value }: { value: string }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;

    if (!element) {
      return undefined;
    }

    const updateOverflow = () => {
      setIsOverflowing(element.scrollWidth > element.clientWidth);
    };

    updateOverflow();

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(updateOverflow);
      resizeObserver.observe(element);

      return () => resizeObserver.disconnect();
    }

    window.addEventListener("resize", updateOverflow);

    return () => window.removeEventListener("resize", updateOverflow);
  }, [value]);

  return (
    <Tooltip
      arrow
      enterDelay={350}
      placement="top-start"
      slotProps={{
        tooltip: {
          sx: {
            maxWidth: 760,
            overflowWrap: "anywhere",
          },
        },
      }}
      title={isOverflowing ? value : ""}
    >
      <Typography
        ref={textRef}
        sx={{
          ...inspectorValueTypographySx,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        variant="body2"
      >
        {value}
      </Typography>
    </Tooltip>
  );
}

function OverviewSizeTree({
  sessionId,
  showTitle = true,
  sizeBreakdown,
}: {
  sessionId: string;
  showTitle?: boolean;
  sizeBreakdown: OverviewSizeBreakdown;
}) {
  const initialExpandedGroups = useMemo(() => buildExpandedState(["request", "response"]), []);
  const [expandedGroups, setExpandedGroups] =
    useState<Record<string, boolean>>(initialExpandedGroups);

  useEffect(() => {
    setExpandedGroups(initialExpandedGroups);
  }, [initialExpandedGroups, sessionId]);

  return (
    <Stack spacing={0}>
      {showTitle ? <Typography variant="subtitle2">{sizeBreakdown.title}</Typography> : null}
      <Stack spacing={0}>
        {sizeBreakdown.groups.map((group) => {
          const isExpanded = expandedGroups[group.key] ?? true;

          return (
            <Stack key={group.title} spacing={0}>
              <OverviewTreeHeader
                expanded={isExpanded}
                indent={3.25}
                onClick={() => {
                  setExpandedGroups((current) => ({
                    ...current,
                    [group.key]: !isExpanded,
                  }));
                }}
                title={group.title}
                value={group.total}
              />

              {isExpanded ? <OverviewDefinitionList indent={6.5} items={group.items} /> : null}
            </Stack>
          );
        })}
        <OverviewGridRow
          label={
            <Typography sx={{ ...inspectorValueTypographySx, fontWeight: 600 }} variant="body2">
              {sizeBreakdown.total[0]}
            </Typography>
          }
          labelIndent={3.25}
          value={sizeBreakdown.total[1]}
        />
      </Stack>
    </Stack>
  );
}

function buildExpandedState(keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

function buildOverviewSections({
  detail,
  session,
  t,
}: {
  detail: SessionDetail | undefined;
  session: SessionSummary;
  t: ReturnType<typeof useI18n>["t"];
}): {
  sections: OverviewSection[];
  sizeBreakdown: OverviewSizeBreakdown;
} {
  const fallback = t("common.states.notCaptured");
  const responseContentType =
    getHeaderValue(detail?.responseHeaders, "content-type") ??
    detail?.responseBody?.mimeType ??
    session.responseMimeType ??
    fallback;
  const protocolMetadata = getSessionProtocolMetadata(session);
  const requestContentEncoding = getHeaderValue(detail?.requestHeaders, "content-encoding");
  const responseContentEncoding = getHeaderValue(detail?.responseHeaders, "content-encoding");
  const requestHeaderBytes = estimateHeaderBytes(
    detail?.rawRequest,
    detail?.requestHeaders,
    session.method,
    session.path,
    protocolMetadata.httpVersion,
  );
  const responseHeaderBytes = estimateHeaderBytes(
    detail?.rawResponse,
    detail?.responseHeaders,
    undefined,
    undefined,
    protocolMetadata.httpVersion,
    session.statusCode,
  );
  const requestBodyBytes = detail?.requestBody?.sizeBytes ?? 0;
  const responseBodyBytes = detail?.responseBody?.sizeBytes ?? 0;
  const requestTotalBytes = requestHeaderBytes + requestBodyBytes;
  const responseTotalBytes = responseHeaderBytes + responseBodyBytes;
  const totalBytes = requestTotalBytes + responseTotalBytes;
  const timing = detail?.timing;
  const startedAt = formatTimestamp(session.startedAt, fallback);
  const isImportedTiming = isImportedHarSession(session);
  const unavailable = t("common.states.unavailable");
  const responseStartOffsetMs = getResponseStartOffsetMs(timing);
  const requestEndTime = formatOffsetTimestamp(
    session.startedAt,
    getRequestEndOffsetMs(timing, isImportedTiming),
    fallback,
  );
  const responseStartTime = formatOffsetTimestamp(
    session.startedAt,
    responseStartOffsetMs,
    fallback,
  );
  const responseEndTime = formatTimestamp(session.finishedAt, fallback);
  const requestQueryBytes = estimateQueryStringBytes(session.url);
  const requestCookieBytes = detail
    ? estimateCookieBytes(detail.requestHeaders, "cookie")
    : undefined;
  const responseCookieBytes = detail
    ? estimateCookieBytes(detail.responseHeaders, "set-cookie")
    : undefined;
  const requestUncompressedBytes = estimateDecodedBodyBytes(detail?.requestBody);
  const responseUncompressedBytes = estimateDecodedBodyBytes(detail?.responseBody);
  const statusLabel = isClientCancelledStatus(session.statusCode)
    ? t("inspector.request.overview.cancelled")
    : session.statusCode > 0
      ? t("inspector.request.overview.complete")
      : t("common.states.pending");

  return {
    sections: [
      {
        key: "general",
        title: t("inspector.request.overview.sections.general"),
        items: [
          [t("common.labels.url"), session.url],
          [t("common.labels.method"), session.method],
          [t("inspector.request.overview.fields.status"), statusLabel],
          [
            t("inspector.request.overview.fields.responseCode"),
            session.statusCode > 0 ? String(session.statusCode) : fallback,
          ],
          [t("inspector.request.overview.fields.contentType"), responseContentType],
          [t("inspector.request.overview.fields.clientAddress"), detail?.clientAddress ?? fallback],
          [
            t("inspector.request.overview.fields.remoteAddress"),
            buildRemoteAddress(session.url, session.host, detail?.serverIp),
          ],
          [
            t("inspector.request.overview.fields.route"),
            formatRouteValue(detail?.viaUpstreamProxy, t("common.states.na"), t),
          ],
          [t("common.labels.protocol"), formatSessionProtocol(session)],
          [t("inspector.request.overview.fields.tags"), t("common.states.na")],
          [
            t("inspector.request.overview.fields.keptAlive"),
            formatBooleanValue(
              getKeepAlive(detail?.requestHeaders, protocolMetadata.httpVersion),
              fallback,
              t,
            ),
          ],
          [
            t("inspector.request.overview.fields.ssl"),
            formatSslValue(protocolMetadata.scheme, detail, fallback, t("common.states.na")),
          ],
        ],
      },
      {
        key: "timing",
        title: t("inspector.request.overview.sections.timing"),
        items: [
          [t("inspector.request.overview.fields.requestStartTime"), startedAt],
          [t("inspector.request.overview.fields.requestEndTime"), requestEndTime],
          [t("inspector.request.overview.fields.responseStartTime"), responseStartTime],
          [t("inspector.request.overview.fields.responseEndTime"), responseEndTime],
          [
            t("common.labels.duration"),
            formatTiming(timing?.totalMs ?? session.durationMs, fallback),
          ],
          [
            t("inspector.request.overview.fields.dns"),
            formatConnectionPhaseTiming(
              timing?.dnsMs,
              timing,
              isImportedTiming,
              fallback,
              unavailable,
            ),
          ],
          [
            t("inspector.request.overview.fields.connect"),
            formatConnectionPhaseTiming(
              timing?.connectMs,
              timing,
              isImportedTiming,
              fallback,
              unavailable,
            ),
          ],
          [
            t("inspector.request.overview.fields.tlsHandshake"),
            formatTlsTiming(
              timing?.tlsMs,
              timing,
              protocolMetadata.scheme,
              isImportedTiming,
              fallback,
              unavailable,
              t,
            ),
          ],
          [
            t("inspector.request.overview.fields.request"),
            formatRequestPhaseTiming(timing, isImportedTiming, fallback, unavailable),
          ],
          [
            t("inspector.request.overview.fields.response"),
            formatTiming(timing?.responseReadMs, fallback),
          ],
          [
            t("inspector.request.overview.fields.latency"),
            formatTiming(timing?.waitingMs, fallback),
          ],
          [
            t("inspector.request.overview.fields.speed"),
            formatBytesPerSecond(totalBytes, timing?.totalMs ?? session.durationMs, fallback, t),
          ],
          [
            t("inspector.request.overview.fields.requestSpeed"),
            formatRequestBytesPerSecond(
              requestTotalBytes,
              timing,
              isImportedTiming,
              fallback,
              unavailable,
              t,
            ),
          ],
          [
            t("inspector.request.overview.fields.responseSpeed"),
            formatBytesPerSecond(responseTotalBytes, timing?.responseReadMs, fallback, t),
          ],
        ],
      },
    ],
    sizeBreakdown: {
      title: t("inspector.request.overview.sections.size"),
      groups: [
        {
          key: "request",
          title: t("common.labels.request"),
          total: formatBytes(requestTotalBytes, t),
          items: [
            [t("inspector.request.overview.fields.header"), formatBytes(requestHeaderBytes, t)],
            [
              t("inspector.request.overview.fields.queryString"),
              requestQueryBytes != null ? formatBytes(requestQueryBytes, t) : fallback,
            ],
            [
              t("inspector.request.overview.fields.cookies"),
              requestCookieBytes != null ? formatBytes(requestCookieBytes, t) : fallback,
            ],
            [t("common.labels.body"), formatBytes(requestBodyBytes, t)],
            [
              t("inspector.request.overview.fields.uncompressedBody"),
              requestUncompressedBytes != null
                ? formatBytes(requestUncompressedBytes, t)
                : fallback,
            ],
            [
              t("inspector.request.overview.fields.compression"),
              formatCompression(
                requestBodyBytes,
                requestUncompressedBytes,
                requestContentEncoding,
                fallback,
                t("common.states.na"),
              ),
            ],
          ],
        },
        {
          key: "response",
          title: t("common.labels.response"),
          total: formatBytes(responseTotalBytes, t),
          items: [
            [t("inspector.request.overview.fields.header"), formatBytes(responseHeaderBytes, t)],
            [
              t("inspector.request.overview.fields.cookies"),
              responseCookieBytes != null ? formatBytes(responseCookieBytes, t) : fallback,
            ],
            [t("common.labels.body"), formatBytes(responseBodyBytes, t)],
            [
              t("inspector.request.overview.fields.uncompressedBody"),
              responseUncompressedBytes != null
                ? formatBytes(responseUncompressedBytes, t)
                : fallback,
            ],
            [
              t("inspector.request.overview.fields.compression"),
              formatCompression(
                responseBodyBytes,
                responseUncompressedBytes,
                responseContentEncoding,
                fallback,
                t("common.states.na"),
              ),
            ],
          ],
        },
      ],
      total: [t("common.labels.total"), formatBytes(totalBytes, t)],
    },
  };
}

function getHeaderValue(headers: HeaderEntry[] | undefined, name: string) {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function sumMilliseconds(...values: Array<number | undefined>) {
  let total = 0;
  let hasValue = false;

  for (const value of values) {
    if (value == null) {
      continue;
    }

    total += value;
    hasValue = true;
  }

  return hasValue ? total : undefined;
}

function isImportedHarSession(session: SessionSummary) {
  return session.id.startsWith("imported-har-");
}

function getResponseStartOffsetMs(timing: SessionDetail["timing"] | undefined) {
  if (!timing) {
    return undefined;
  }

  if (timing.totalMs != null && timing.responseReadMs != null) {
    return Math.max(0, timing.totalMs - timing.responseReadMs);
  }

  return sumMilliseconds(
    timing.dnsMs,
    timing.connectMs,
    timing.tlsMs,
    timing.requestSendMs,
    timing.waitingMs,
  );
}

function getRequestEndOffsetMs(
  timing: SessionDetail["timing"] | undefined,
  isImportedTiming: boolean,
) {
  if (!timing) {
    return undefined;
  }

  if (isImportedTiming && timing.requestSendMs != null) {
    return sumMilliseconds(timing.dnsMs, timing.connectMs, timing.tlsMs, timing.requestSendMs);
  }

  return undefined;
}

function formatConnectionPhaseTiming(
  value: number | undefined,
  timing: SessionDetail["timing"] | undefined,
  isImportedTiming: boolean,
  fallback: string,
  unavailable: string,
) {
  if (value != null) {
    return formatTiming(value, fallback);
  }

  return timing && !isImportedTiming ? unavailable : fallback;
}

function formatTlsTiming(
  value: number | undefined,
  timing: SessionDetail["timing"] | undefined,
  protocol: string,
  isImportedTiming: boolean,
  fallback: string,
  unavailable: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (value != null) {
    return formatTiming(value, fallback);
  }

  if (protocol.toLowerCase() === "http") {
    return t("common.states.na");
  }

  return timing && !isImportedTiming ? unavailable : fallback;
}

function hasDetailedRequestSendTiming(
  timing: SessionDetail["timing"] | undefined,
  isImportedTiming: boolean,
) {
  if (timing?.requestSendMs == null) {
    return false;
  }

  return isImportedTiming;
}

function formatRequestPhaseTiming(
  timing: SessionDetail["timing"] | undefined,
  isImportedTiming: boolean,
  fallback: string,
  unavailable: string,
) {
  if (hasDetailedRequestSendTiming(timing, isImportedTiming)) {
    return formatTiming(timing?.requestSendMs, fallback);
  }

  return timing && !isImportedTiming ? unavailable : fallback;
}

function formatTimestamp(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    hour12: false,
    timeStyle: "medium",
  }).format(date);
}

function formatOffsetTimestamp(
  baseValue: string | undefined,
  offsetMs: number | undefined,
  fallback: string,
) {
  if (!baseValue || offsetMs == null) {
    return fallback;
  }

  const baseDate = new Date(baseValue);

  if (Number.isNaN(baseDate.getTime())) {
    return fallback;
  }

  return formatTimestamp(new Date(baseDate.getTime() + offsetMs).toISOString(), fallback);
}

function formatBytes(value: number, t: ReturnType<typeof useI18n>["t"]) {
  return t("common.tech.bytes", { value });
}

function formatBytesPerSecond(
  bytes: number,
  durationMs: number | undefined,
  fallback: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (!durationMs || durationMs <= 0) {
    if (durationMs === 0 && bytes > 0) {
      return formatBytesPerSecondValue(bytes / 0.001, t);
    }

    return fallback;
  }

  return formatBytesPerSecondValue(bytes / (durationMs / 1000), t);
}

function formatBytesPerSecondValue(bytesPerSecond: number, t: ReturnType<typeof useI18n>["t"]) {
  if (bytesPerSecond >= 1024 * 1024) {
    return t("common.tech.megabytesPerSecond", {
      value: (bytesPerSecond / (1024 * 1024)).toFixed(2),
    });
  }

  if (bytesPerSecond >= 1024) {
    return t("common.tech.kilobytesPerSecond", { value: (bytesPerSecond / 1024).toFixed(2) });
  }

  return t("common.tech.bytesPerSecond", { value: Math.round(bytesPerSecond) });
}

function formatRequestBytesPerSecond(
  bytes: number,
  timing: SessionDetail["timing"] | undefined,
  isImportedTiming: boolean,
  fallback: string,
  unavailable: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (!timing) {
    return fallback;
  }

  if (!hasDetailedRequestSendTiming(timing, isImportedTiming)) {
    return isImportedTiming ? fallback : unavailable;
  }

  return formatBytesPerSecond(bytes, timing.requestSendMs, fallback, t);
}

function formatCompression(
  compressedBytes: number,
  uncompressedBytes: number | undefined,
  encoding: string | undefined,
  fallback: string,
  na: string,
) {
  if (!encoding) {
    return na;
  }

  if (!uncompressedBytes || uncompressedBytes <= 0) {
    return fallback;
  }

  const savedRatio = ((uncompressedBytes - compressedBytes) / uncompressedBytes) * 100;

  return `${savedRatio.toFixed(1)}% (${encoding})`;
}

function estimateHeaderBytes(
  rawMessage: string | undefined,
  headers: HeaderEntry[] | undefined,
  method?: string,
  path?: string,
  protocol?: string,
  statusCode?: number,
) {
  if (!rawMessage) {
    if (!headers || headers.length === 0) {
      return 0;
    }

    const startLine =
      statusCode != null && statusCode > 0
        ? `HTTP/${normalizeProtocolVersion(protocol)} ${statusCode}\r\n`
        : `${method ?? "GET"} ${path ?? "/"} HTTP/${normalizeProtocolVersion(protocol)}\r\n`;
    const headerText = `${startLine}${headers.map((header) => `${header.name}: ${header.value}\r\n`).join("")}\r\n`;

    return new TextEncoder().encode(headerText).length;
  }

  const separatorIndex = rawMessage.indexOf("\r\n\r\n");
  const headerText = separatorIndex >= 0 ? rawMessage.slice(0, separatorIndex + 4) : rawMessage;

  return new TextEncoder().encode(headerText).length;
}

function estimateDecodedBodyBytes(body: BodyReference | undefined) {
  const base64Text = body?.base64Text;

  if (!base64Text) {
    if (body?.inlineText) {
      return new TextEncoder().encode(body.inlineText).length;
    }

    return undefined;
  }

  const paddingLength = base64Text.endsWith("==") ? 2 : base64Text.endsWith("=") ? 1 : 0;

  return Math.floor((base64Text.length * 3) / 4) - paddingLength;
}

function estimateQueryStringBytes(urlValue: string) {
  try {
    const queryString = new URL(urlValue).search;

    if (!queryString) {
      return undefined;
    }

    return new TextEncoder().encode(queryString).length;
  } catch {
    return undefined;
  }
}

function estimateCookieBytes(headers: HeaderEntry[] | undefined, headerName: string) {
  const matchingHeaders =
    headers?.filter((header) => header.name.toLowerCase() === headerName.toLowerCase()) ?? [];

  if (matchingHeaders.length === 0) {
    return headers ? 0 : undefined;
  }

  return matchingHeaders.reduce(
    (total, header) =>
      total + new TextEncoder().encode(`${header.name}: ${header.value}\r\n`).length,
    0,
  );
}

function normalizeProtocolVersion(protocol: string | undefined) {
  if (!protocol) {
    return "1.1";
  }

  if (protocol.startsWith("HTTP/")) {
    return protocol.slice("HTTP/".length);
  }

  if (/^\d(?:\.\d)?$/.test(protocol)) {
    return protocol;
  }

  if (protocol.toLowerCase() === "http2") {
    return "2";
  }

  if (protocol.toLowerCase() === "h2") {
    return "2";
  }

  return "1.1";
}

function buildRemoteAddress(urlValue: string, host: string, serverIp: string | undefined) {
  try {
    const url = new URL(urlValue);
    const port =
      url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    const endpoint = port ? `${host}:${port}` : host;

    return serverIp ? `${endpoint} / ${serverIp}` : endpoint;
  } catch {
    return serverIp ? `${host} / ${serverIp}` : host;
  }
}

function getKeepAlive(headers: HeaderEntry[] | undefined, protocol: string) {
  const connection = getHeaderValue(headers, "connection");

  if (connection) {
    return connection.toLowerCase() !== "close";
  }

  if (
    protocol.toLowerCase() === "http" ||
    protocol.toLowerCase() === "https" ||
    protocol === "1.1" ||
    protocol === "2" ||
    protocol === "3"
  ) {
    return true;
  }

  return undefined;
}

function formatBooleanValue(
  value: boolean | undefined,
  fallback: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (value == null) {
    return fallback;
  }

  return value ? t("inspector.request.overview.yes") : t("inspector.request.overview.no");
}

/**
 * Describe how this request reached the network.
 *
 * `undefined` means there was no routing decision to report — a mocked /
 * Map Local / script response never dialed out, and sessions captured before
 * this field existed carry no value either. Those show as N/A rather than
 * "direct", which would wrongly suggest the upstream proxy had been skipped.
 */
function formatRouteValue(
  viaUpstreamProxy: boolean | undefined,
  na: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (viaUpstreamProxy == null) {
    return na;
  }

  return viaUpstreamProxy
    ? t("inspector.request.overview.routeUpstreamProxy")
    : t("inspector.request.overview.routeDirect");
}

function formatSslValue(
  protocol: string,
  detail: SessionDetail | undefined,
  fallback: string,
  na: string,
) {
  if (detail?.tlsProtocol) {
    return detail.tlsCipherSuite
      ? `${detail.tlsProtocol} (${detail.tlsCipherSuite})`
      : detail.tlsProtocol;
  }

  const normalizedProtocol = protocol.toLowerCase();

  if (normalizedProtocol === "http" || normalizedProtocol === "ws") {
    return na;
  }

  if (
    normalizedProtocol === "https" ||
    normalizedProtocol === "connect" ||
    normalizedProtocol === "wss"
  ) {
    return detail ? fallback : "HTTPS";
  }

  return fallback;
}
