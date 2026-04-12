import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import { Box, Button, Chip, List, ListItem, Stack, Typography } from "@mui/material";
import { Fragment } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { getStatusColor, normalizeSearch } from "./session-inspector.helpers";

export function InspectorSummaryBar({
  detail,
  session,
}: {
  detail: SessionDetail | undefined;
  session: SessionSummary;
}) {
  return (
    <Stack spacing={0.75} sx={{ px: 1.5, py: 1 }}>
      <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={1.5}>
        <Stack alignItems="center" direction="row" spacing={1} sx={{ minWidth: 0 }}>
          <Chip
            color={getStatusColor(session.statusCode)}
            label={session.method}
            size="small"
            variant="outlined"
          />
          <Typography noWrap variant="subtitle2">
            {session.path || "/"}
          </Typography>
          <Typography color="text.secondary" noWrap variant="caption">
            {session.statusCode} • {session.durationMs} ms • {session.sizeBytes} bytes
          </Typography>
        </Stack>

        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(session.url);
          }}
          size="small"
          startIcon={<ContentCopyRoundedIcon />}
          sx={{ minWidth: 0, px: 1.25 }}
          variant="text"
        >
          Copy URL
        </Button>
      </Stack>

      <Typography color="text.secondary" noWrap sx={{ fontSize: 11.5, lineHeight: 1.3 }}>
        {session.host} • {session.protocol} • {session.url}
        {detail?.serverIp ? ` • ${detail.serverIp}` : ""}
      </Typography>
    </Stack>
  );
}

export function InspectorDefinitionList({
  emptyMessage,
  items,
}: {
  emptyMessage?: string;
  items: Array<[string, string]>;
}) {
  if (items.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? "No data available."}
      </Typography>
    );
  }

  return (
    <List disablePadding>
      {items.map(([label, value]) => (
        <ListItem
          disableGutters
          divider
          key={`${label}:${value}`}
          sx={{ alignItems: "center", columnGap: 2, py: 0.75 }}
        >
          <Typography
            color="text.secondary"
            sx={{ flex: "0 0 180px", minWidth: 0, pr: 1 }}
            variant="caption"
          >
            {label}
          </Typography>
          <Typography sx={{ flex: 1, minWidth: 0, wordBreak: "break-all" }} variant="body2">
            {value}
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

export function InspectorFlatTable({
  children,
  columnTemplate,
  headers,
}: {
  children: React.ReactNode;
  columnTemplate: string;
  headers: [string, string] | [string, string, string];
}) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          bgcolor: "background.paper",
          display: "grid",
          gridTemplateColumns: columnTemplate,
          minHeight: 20,
        }}
      >
        {headers.map((header) => (
          <Typography
            color="text.secondary"
            key={header}
            sx={{
              fontSize: 11,
              fontWeight: 400,
              lineHeight: 1.2,
              px: 0.75,
              py: 0.25,
            }}
            variant="caption"
          >
            {header}
          </Typography>
        ))}
      </Box>
      <Box>{children}</Box>
    </Box>
  );
}

export function InspectorFlatTableRow({
  cells,
  columnTemplate,
  dense = false,
  hoverable = false,
}: {
  cells: React.ReactNode[];
  columnTemplate: string;
  dense?: boolean;
  hoverable?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: columnTemplate,
        minHeight: dense ? 22 : 24,
        ...(hoverable
          ? {
              borderRadius: 0.5,
              transition: "background-color 120ms ease",
              "&:hover": {
                bgcolor: "action.hover",
              },
            }
          : undefined),
      }}
    >
      {cells.map((cell, index) => (
        <Box
          key={index}
          sx={{
            alignItems: "center",
            display: "flex",
            minWidth: 0,
            px: 0.75,
            py: dense ? 0.25 : 0.375,
          }}
        >
          {cell}
        </Box>
      ))}
    </Box>
  );
}

export function InspectorKeyValueTable({
  emptyMessage,
  items,
  keyHeader = "Name",
  valueHeader = "Value",
}: {
  emptyMessage?: string;
  items: Array<[string, string]>;
  keyHeader?: string;
  valueHeader?: string;
}) {
  if (items.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? "No data available."}
      </Typography>
    );
  }

  const columnTemplate = "minmax(156px, 0.84fr) minmax(0, 1.9fr)";

  return (
    <InspectorFlatTable columnTemplate={columnTemplate} headers={[keyHeader, valueHeader]}>
      {items.map(([label, value], index) => (
        <InspectorFlatTableRow
          cells={[
            <Typography key="label" sx={{ minWidth: 0, wordBreak: "break-all" }} variant="body2">
              {label}
            </Typography>,
            <Typography key="value" sx={{ minWidth: 0, wordBreak: "break-all" }} variant="body2">
              {value}
            </Typography>,
          ]}
          columnTemplate={columnTemplate}
          dense
          key={`${label}:${value}:${index}`}
        />
      ))}
    </InspectorFlatTable>
  );
}

export function SearchableCodeBlock({
  code,
  language = "plain",
  searchQuery,
}: {
  code: string;
  language?: "json" | "plain";
  searchQuery: string;
}) {
  return (
    <Box
      component="pre"
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: language === "json" ? 13.5 : 12.5,
        lineHeight: language === "json" ? 1.6 : 1.5,
        m: 0,
        overflowX: "auto",
        px: 0.5,
        py: 0.25,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {language === "json" ? renderJsonSyntaxHighlightedText(code, searchQuery) : renderHighlightedText(code, searchQuery)}
    </Box>
  );
}

export function renderJsonSyntaxHighlightedText(text: string, searchQuery?: string) {
  const tokenPattern = /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  const tokenColors = {
    boolean: "#0000ff",
    key: "#a31515",
    null: "#0000ff",
    number: "#098658",
    punctuation: "text.primary",
    string: "#0451a5",
  } as const;

  for (const match of text.matchAll(tokenPattern)) {
    const matchedText = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > cursor) {
      segments.push(text.slice(cursor, matchIndex));
    }

    if (match[1]) {
      const stringToken = match[1];
      const hasColon = Boolean(match[2]);

      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: hasColon ? tokenColors.key : tokenColors.string }}>
          {renderHighlightedText(stringToken, searchQuery)}
        </Box>,
      );

      if (hasColon) {
        segments.push(
          <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.punctuation }}>
            {match[2]}
          </Box>,
        );
      }
    } else if (matchedText === "true" || matchedText === "false") {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.boolean }}>
          {renderHighlightedText(matchedText, searchQuery)}
        </Box>,
      );
    } else if (matchedText === "null") {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.null }}>
          {renderHighlightedText(matchedText, searchQuery)}
        </Box>,
      );
    } else if (/^-?\d/.test(matchedText)) {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.number }}>
          {renderHighlightedText(matchedText, searchQuery)}
        </Box>,
      );
    } else {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.punctuation }}>
          {matchedText}
        </Box>,
      );
    }

    cursor = matchIndex + matchedText.length;
  }

  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return segments.map((segment, index) => <Fragment key={index}>{segment}</Fragment>);
}

export function renderHighlightedText(text: string, searchQuery?: string) {
  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return text;
  }

  const source = text.toLowerCase();
  const segments: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = source.indexOf(normalizedQuery, cursor);

    if (matchIndex === -1) {
      segments.push(text.slice(cursor));
      break;
    }

    if (matchIndex > cursor) {
      segments.push(text.slice(cursor, matchIndex));
    }

    const endIndex = matchIndex + normalizedQuery.length;
    segments.push(
      <Box component="mark" key={`${matchIndex}-${endIndex}`} sx={{ bgcolor: "warning.light", px: 0.25 }}>
        {text.slice(matchIndex, endIndex)}
      </Box>,
    );
    cursor = endIndex;
  }

  return segments.map((segment, index) => <Fragment key={index}>{segment}</Fragment>);
}
