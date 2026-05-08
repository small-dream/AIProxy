import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, ButtonBase, Stack, Tooltip, Typography } from "@mui/material";
import type { BodyReference, HeaderEntry, SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "@/i18n";
import { InspectorScrollArea } from "./SessionInspectorShared";
import { formatTiming } from "./session-inspector.helpers";

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
  const { sections, sizeBreakdown } = useMemo(() => buildOverviewSections({
    detail,
    session,
    t,
  }), [detail, session, t]);
  const overviewBlocks = useMemo<OverviewBlock[]>(() => [
    ...sections.map((section) => ({
      key: section.key,
      title: section.title,
      content: <OverviewDefinitionList indent={section.key === "general" ? 0 : 3.25} items={section.items} />,
    })),
    {
      key: "size",
      title: sizeBreakdown.title,
      content: <OverviewSizeTree sessionId={session.id} showTitle={false} sizeBreakdown={sizeBreakdown} />,
    },
  ], [sections, session.id, sizeBreakdown]);
  const initialExpandedBlocks = useMemo(
    () => ({ ...buildExpandedState(["general", "timing", "size"]), connection: false }),
    [],
  );
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>(initialExpandedBlocks);

  useEffect(() => {
    setExpandedBlocks(initialExpandedBlocks);
  }, [initialExpandedBlocks, session.id]);

  return (
    <InspectorScrollArea>
      <Stack spacing={0} sx={{ pb: 1, pt: 0.25 }}>
        {leading ? <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>{leading}</Stack> : null}
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
        label={(
          <Stack alignItems="center" direction="row" spacing={0.5}>
            {expanded ? (
              <ExpandMoreRoundedIcon sx={{ color: "text.disabled", fontSize: 18 }} />
            ) : (
              <ChevronRightRoundedIcon sx={{ color: "text.disabled", fontSize: 18 }} />
            )}
            <Typography sx={{ color: "text.primary", fontSize: 14, fontWeight: 700 }} variant="body2">
              {title}
            </Typography>
          </Stack>
        )}
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
      <Typography color="text.secondary" sx={{ fontSize: 13.5 }} variant="body2">
        {t("common.empty.noData")}
      </Typography>
    );
  }

  return (
    <Stack spacing={0}>
      {items.map(([label, value]) => (
        <OverviewGridRow
          key={`${label}:${value}`}
          label={(
            <Typography color="text.secondary" sx={{ fontSize: 13.5, fontWeight: 500 }} variant="body2">
              {label}
            </Typography>
          )}
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
        gridTemplateColumns: {
          xs: "minmax(132px, 36%) minmax(0, 1fr)",
          md: "minmax(220px, 42%) minmax(0, 1fr)",
        },
        minHeight: 28,
      }}
    >
      <Box sx={{ minWidth: 0, pl: labelIndent }}>
        {label}
      </Box>
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
          color: "text.primary",
          fontSize: 13.5,
          fontWeight: 500,
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
  const initialExpandedGroups = useMemo(
    () => buildExpandedState(["request", "response"]),
    [],
  );
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(initialExpandedGroups);

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

              {isExpanded ? (
                <OverviewDefinitionList indent={6.5} items={group.items} />
              ) : null}
            </Stack>
          );
        })}
        <OverviewGridRow
          label={(
            <Typography sx={{ color: "text.primary", fontSize: 14, fontWeight: 700 }} variant="body2">
              {sizeBreakdown.total[0]}
            </Typography>
          )}
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
  const responseContentType = getHeaderValue(detail?.responseHeaders, "content-type")
    ?? detail?.responseBody?.mimeType
    ?? session.responseMimeType
    ?? fallback;
  const requestContentEncoding = getHeaderValue(detail?.requestHeaders, "content-encoding");
  const responseContentEncoding = getHeaderValue(detail?.responseHeaders, "content-encoding");
  const requestHeaderBytes = estimateHeaderBytes(detail?.rawRequest, detail?.requestHeaders, session.method, session.path, session.protocol);
  const responseHeaderBytes = estimateHeaderBytes(detail?.rawResponse, detail?.responseHeaders, undefined, undefined, session.protocol, session.statusCode);
  const requestBodyBytes = detail?.requestBody?.sizeBytes ?? 0;
  const responseBodyBytes = detail?.responseBody?.sizeBytes ?? 0;
  const requestTotalBytes = requestHeaderBytes + requestBodyBytes;
  const responseTotalBytes = responseHeaderBytes + responseBodyBytes;
  const totalBytes = requestTotalBytes + responseTotalBytes;
  const timing = detail?.timing;
  const startedAt = formatTimestamp(session.startedAt, fallback);
  const requestEndTime = formatOffsetTimestamp(
    session.startedAt,
    sumMilliseconds(timing?.dnsMs, timing?.connectMs, timing?.tlsMs, timing?.requestSendMs),
    fallback,
  );
  const responseStartTime = formatOffsetTimestamp(
    session.startedAt,
    sumMilliseconds(timing?.dnsMs, timing?.connectMs, timing?.tlsMs, timing?.requestSendMs, timing?.waitingMs),
    fallback,
  );
  const responseEndTime = formatTimestamp(session.finishedAt, fallback);
  const requestQueryBytes = estimateQueryStringBytes(session.url);
  const requestCookieBytes = estimateCookieBytes(detail?.requestHeaders, "cookie");
  const responseCookieBytes = estimateCookieBytes(detail?.responseHeaders, "set-cookie");
  const requestUncompressedBytes = estimateDecodedBodyBytes(detail?.requestBody);
  const responseUncompressedBytes = estimateDecodedBodyBytes(detail?.responseBody);

  return {
    sections: [
      {
        key: "general",
        title: t("inspector.request.overview.sections.general"),
        items: [
          [t("common.labels.url"), session.url],
          [t("common.labels.method"), session.method],
          [t("inspector.request.overview.fields.status"), session.statusCode > 0 ? t("inspector.request.overview.complete") : t("common.states.pending")],
          [t("inspector.request.overview.fields.responseCode"), session.statusCode > 0 ? String(session.statusCode) : fallback],
          [t("inspector.request.overview.fields.contentType"), responseContentType],
          [t("inspector.request.overview.fields.clientAddress"), fallback],
          [t("inspector.request.overview.fields.remoteAddress"), buildRemoteAddress(session.url, session.host, detail?.serverIp)],
          [t("common.labels.protocol"), formatProtocol(session.protocol)],
          [t("inspector.request.overview.fields.tags"), t("common.states.na")],
          [t("inspector.request.overview.fields.keptAlive"), formatBooleanValue(getKeepAlive(detail?.requestHeaders, session.protocol), fallback, t)],
          [t("inspector.request.overview.fields.ssl"), formatSslValue(session.protocol, fallback)],
        ],
      },
      {
        key: "connection",
        title: t("inspector.request.overview.sections.connection"),
        items: [
          [t("inspector.request.overview.fields.clientConnection"), fallback],
          [t("inspector.request.overview.fields.serverConnection"), fallback],
          [t("inspector.request.overview.fields.streamId"), fallback],
          [t("inspector.request.overview.fields.clientSettings"), fallback],
          [t("inspector.request.overview.fields.serverSettings"), fallback],
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
          [t("common.labels.duration"), formatTiming(timing?.totalMs ?? session.durationMs, fallback)],
          [t("inspector.request.overview.fields.dns"), formatTiming(timing?.dnsMs, fallback)],
          [t("inspector.request.overview.fields.connect"), formatTiming(timing?.connectMs, fallback)],
          [t("inspector.request.overview.fields.tlsHandshake"), formatTiming(timing?.tlsMs, fallback)],
          [t("inspector.request.overview.fields.request"), formatTiming(timing?.requestSendMs, fallback)],
          [t("inspector.request.overview.fields.response"), formatTiming(timing?.responseReadMs, fallback)],
          [t("inspector.request.overview.fields.latency"), formatTiming(timing?.waitingMs, fallback)],
          [t("inspector.request.overview.fields.speed"), formatBytesPerSecond(totalBytes, timing?.totalMs ?? session.durationMs, fallback, t)],
          [t("inspector.request.overview.fields.requestSpeed"), formatBytesPerSecond(requestTotalBytes, timing?.requestSendMs, fallback, t)],
          [t("inspector.request.overview.fields.responseSpeed"), formatBytesPerSecond(responseTotalBytes, timing?.responseReadMs, fallback, t)],
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
            [t("inspector.request.overview.fields.tlsHandshake"), fallback],
            [t("inspector.request.overview.fields.header"), formatBytes(requestHeaderBytes, t)],
            [t("inspector.request.overview.fields.queryString"), requestQueryBytes != null ? formatBytes(requestQueryBytes, t) : fallback],
            [t("inspector.request.overview.fields.cookies"), requestCookieBytes != null ? formatBytes(requestCookieBytes, t) : fallback],
            [t("common.labels.body"), formatBytes(requestBodyBytes, t)],
            [t("inspector.request.overview.fields.uncompressedBody"), requestUncompressedBytes != null ? formatBytes(requestUncompressedBytes, t) : fallback],
            [t("inspector.request.overview.fields.compression"), formatCompression(requestBodyBytes, requestUncompressedBytes, requestContentEncoding, fallback)],
          ],
        },
        {
          key: "response",
          title: t("common.labels.response"),
          total: formatBytes(responseTotalBytes, t),
          items: [
            [t("inspector.request.overview.fields.tlsHandshake"), fallback],
            [t("inspector.request.overview.fields.header"), formatBytes(responseHeaderBytes, t)],
            [t("inspector.request.overview.fields.cookies"), responseCookieBytes != null ? formatBytes(responseCookieBytes, t) : fallback],
            [t("common.labels.body"), formatBytes(responseBodyBytes, t)],
            [t("inspector.request.overview.fields.uncompressedBody"), responseUncompressedBytes != null ? formatBytes(responseUncompressedBytes, t) : fallback],
            [t("inspector.request.overview.fields.compression"), formatCompression(responseBodyBytes, responseUncompressedBytes, responseContentEncoding, fallback)],
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

function formatOffsetTimestamp(baseValue: string | undefined, offsetMs: number | undefined, fallback: string) {
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
    return fallback;
  }

  const bytesPerSecond = bytes / (durationMs / 1000);

  if (bytesPerSecond >= 1024 * 1024) {
    return t("common.tech.megabytesPerSecond", { value: (bytesPerSecond / (1024 * 1024)).toFixed(2) });
  }

  if (bytesPerSecond >= 1024) {
    return t("common.tech.kilobytesPerSecond", { value: (bytesPerSecond / 1024).toFixed(2) });
  }

  return t("common.tech.bytesPerSecond", { value: Math.round(bytesPerSecond) });
}

function formatCompression(
  compressedBytes: number,
  uncompressedBytes: number | undefined,
  encoding: string | undefined,
  fallback: string,
) {
  if (!encoding || !uncompressedBytes || uncompressedBytes <= 0) {
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

    const startLine = statusCode != null && statusCode > 0
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
  const matchingHeaders = headers?.filter((header) => header.name.toLowerCase() === headerName.toLowerCase()) ?? [];

  if (matchingHeaders.length === 0) {
    return undefined;
  }

  return matchingHeaders.reduce((total, header) => total + new TextEncoder().encode(`${header.name}: ${header.value}\r\n`).length, 0);
}

function formatProtocol(protocol: string) {
  return protocol.toUpperCase();
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
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
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

  if (protocol.toLowerCase() === "http" || protocol.toLowerCase() === "https") {
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

function formatSslValue(protocol: string, fallback: string) {
  if (protocol.toLowerCase() === "https") {
    return "HTTPS";
  }

  if (protocol.toLowerCase() === "connect") {
    return "CONNECT";
  }

  return fallback;
}
