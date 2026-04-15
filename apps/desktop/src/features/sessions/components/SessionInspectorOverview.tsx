import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, ButtonBase, Divider, Stack, Typography } from "@mui/material";
import type { BodyReference, HeaderEntry, SessionDetail, SessionSummary } from "@pharles/shared-types";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "@/i18n";
import { InspectorDefinitionList, InspectorScrollArea } from "./SessionInspectorShared";
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
      content: <InspectorDefinitionList items={section.items} />,
    })),
    {
      key: "size",
      title: sizeBreakdown.title,
      content: <OverviewSizeTree sessionId={session.id} showTitle={false} sizeBreakdown={sizeBreakdown} />,
    },
  ], [sections, session.id, sizeBreakdown]);
  const initialExpandedBlocks = useMemo(
    () => buildExpandedState(["general", "connection", "timing", "size"]),
    [],
  );
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>(initialExpandedBlocks);

  useEffect(() => {
    setExpandedBlocks(initialExpandedBlocks);
  }, [initialExpandedBlocks, session.id]);

  return (
    <InspectorScrollArea>
      <Stack spacing={1.5}>
        {leading ? <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>{leading}</Stack> : null}
        <Stack
          divider={<Divider />}
          spacing={0}
          sx={{
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 0.5,
            overflow: "hidden",
          }}
        >
          {overviewBlocks.map((block) => {
            const isExpanded = expandedBlocks[block.key] ?? true;

            return (
              <Stack key={block.key} spacing={0}>
                <ButtonBase
                  aria-expanded={isExpanded}
                  disableRipple
                  onClick={() => {
                    setExpandedBlocks((current) => ({
                      ...current,
                      [block.key]: !isExpanded,
                    }));
                  }}
                  sx={{
                    display: "block",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <Box
                    sx={{
                      alignItems: "center",
                      display: "grid",
                      gridTemplateColumns: "1fr",
                      minHeight: 30,
                      px: 1,
                      py: 0,
                      "&:hover": {
                        bgcolor: "action.hover",
                      },
                    }}
                  >
                    <Stack alignItems="center" direction="row" spacing={0.5}>
                      {isExpanded ? (
                        <ExpandMoreRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
                      ) : (
                        <ChevronRightRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
                      )}
                      <Typography sx={{ fontSize: 11.5, fontWeight: 700 }} variant="body2">
                        {block.title}
                      </Typography>
                    </Stack>
                  </Box>
                </ButtonBase>

                {isExpanded ? (
                  <Box
                    sx={{
                      bgcolor: (theme) => theme.palette.mode === "light" ? theme.palette.common.white : "background.paper",
                      pb: 0.5,
                      px: 1,
                      pt: 0,
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
    <Stack spacing={0.75}>
      {showTitle ? <Typography variant="subtitle2">{sizeBreakdown.title}</Typography> : null}
      <Stack
        divider={<Divider />}
        spacing={0}
        sx={{
          bgcolor: (theme) => theme.palette.mode === "light" ? theme.palette.common.white : "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 0.5,
          overflow: "hidden",
        }}
      >
        {sizeBreakdown.groups.map((group) => {
          const isExpanded = expandedGroups[group.key] ?? true;

          return (
            <Stack key={group.title} spacing={0}>
              <ButtonBase
                aria-expanded={isExpanded}
                disableRipple
                onClick={() => {
                    setExpandedGroups((current) => ({
                      ...current,
                      [group.key]: !isExpanded,
                    }));
                  }}
                sx={{
                  display: "block",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <Box
                  sx={{
                    alignItems: "center",
                    bgcolor: "transparent",
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    minHeight: 34,
                    px: 1,
                    py: 0,
                    transition: "background-color 120ms ease",
                    "&:hover": {
                      bgcolor: "action.hover",
                    },
                  }}
                >
                  <Stack alignItems="center" direction="row" spacing={0.75}>
                    {isExpanded ? (
                      <ExpandMoreRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
                    ) : (
                      <ChevronRightRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
                    )}
                    <Typography
                      sx={{ color: "text.primary", fontSize: 12, fontWeight: 700 }}
                      variant="body2"
                    >
                      {group.title}
                    </Typography>
                  </Stack>
                  <Typography sx={{ color: "text.primary", fontSize: 12 }} variant="body2">
                    {group.total}
                  </Typography>
                </Box>
              </ButtonBase>

              {isExpanded ? (
                <Stack
                  spacing={0}
                  sx={{
                    bgcolor: (theme) => theme.palette.mode === "light" ? theme.palette.common.white : "transparent",
                    pb: 0.5,
                    pl: 5,
                    pr: 1,
                    pt: 0.5,
                  }}
                >
                  {group.items.map(([label, value]) => (
                    <Box
                      key={`${group.title}:${label}:${value}`}
                      sx={{
                        bgcolor: (theme) => theme.palette.mode === "light" ? theme.palette.common.white : "transparent",
                        columnGap: 2,
                        display: "grid",
                        gridTemplateColumns: "180px minmax(0, 1fr)",
                        minHeight: 24,
                        py: 0,
                      }}
                    >
                      <Typography color="text.secondary" sx={{ fontSize: 11.5, minWidth: 0 }} variant="body2">
                        {label}
                      </Typography>
                      <Typography sx={{ fontSize: 11.5, minWidth: 0, wordBreak: "break-all" }} variant="body2">
                        {value}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          );
        })}

        <Box
          sx={{
            alignItems: "center",
            bgcolor: (theme) => theme.palette.mode === "light" ? theme.palette.common.white : "transparent",
            columnGap: 2,
            display: "grid",
            gridTemplateColumns: "1fr auto",
            minHeight: 32,
            px: 1,
            py: 0,
          }}
        >
          <Typography sx={{ fontSize: 12, fontWeight: 700 }} variant="body2">
            {sizeBreakdown.total[0]}
          </Typography>
          <Typography sx={{ fontSize: 12 }} variant="body2">{sizeBreakdown.total[1]}</Typography>
        </Box>
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
  const requestContentType = getHeaderValue(detail?.requestHeaders, "content-type") ?? fallback;
  const requestContentEncoding = getHeaderValue(detail?.requestHeaders, "content-encoding");
  const responseContentEncoding = getHeaderValue(detail?.responseHeaders, "content-encoding");
  const requestHeaderBytes = estimateHeaderBytes(detail?.rawRequest);
  const responseHeaderBytes = estimateHeaderBytes(detail?.rawResponse);
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
          [t("inspector.request.overview.fields.contentType"), requestContentType],
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
          [t("inspector.request.overview.fields.speed"), formatBytesPerSecond(totalBytes, timing?.totalMs ?? session.durationMs, fallback)],
          [t("inspector.request.overview.fields.requestSpeed"), formatBytesPerSecond(requestTotalBytes, timing?.requestSendMs, fallback)],
          [t("inspector.request.overview.fields.responseSpeed"), formatBytesPerSecond(responseTotalBytes, timing?.responseReadMs, fallback)],
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

function formatBytesPerSecond(bytes: number, durationMs: number | undefined, fallback: string) {
  if (!durationMs || durationMs <= 0) {
    return fallback;
  }

  const bytesPerSecond = bytes / (durationMs / 1000);

  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
  }

  return `${Math.round(bytesPerSecond)} B/s`;
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

function estimateHeaderBytes(rawMessage: string | undefined) {
  if (!rawMessage) {
    return 0;
  }

  const separatorIndex = rawMessage.indexOf("\r\n\r\n");
  const headerText = separatorIndex >= 0 ? rawMessage.slice(0, separatorIndex + 4) : rawMessage;

  return new TextEncoder().encode(headerText).length;
}

function estimateDecodedBodyBytes(body: BodyReference | undefined) {
  const base64Text = body?.base64Text;

  if (!base64Text) {
    return body?.inlineText ? new TextEncoder().encode(body.inlineText).length : undefined;
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
