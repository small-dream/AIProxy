import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import {
  Box,
  Button,
  Chip,
  List,
  ListItem,
  Stack,
  Typography,
} from "@mui/material";
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

export function SearchableCodeBlock({
  code,
  searchQuery,
}: {
  code: string;
  searchQuery: string;
}) {
  return (
    <Box
      component="pre"
      sx={{
        bgcolor: "action.hover",
        border: 1,
        borderColor: "divider",
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 1.5,
        m: 0,
        overflowX: "auto",
        p: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {renderHighlightedText(code, searchQuery)}
    </Box>
  );
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
