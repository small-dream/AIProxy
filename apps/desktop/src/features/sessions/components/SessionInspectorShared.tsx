import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import LaunchRoundedIcon from "@mui/icons-material/LaunchRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import { Box, Button, Chip, IconButton, List, ListItem, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { Fragment, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { useI18n } from "@/i18n";
import { getSyntaxColors } from "@/themes/app-theme";
import { getMethodColor, getStatusColor, normalizeSearch } from "./session-inspector.helpers";

export function InspectorSummaryBar({
  detail,
  onRepeat,
  session,
}: {
  detail: SessionDetail | undefined;
  onRepeat?: (() => void) | undefined;
  session: SessionSummary;
}) {
  const { t } = useI18n();

  return (
    <Stack spacing={0.75} sx={{ px: 1.5, py: 1 }}>
      <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={1.5}>
        <Stack alignItems="center" direction="row" spacing={1} sx={{ minWidth: 0 }}>
          <Chip
            color={getMethodColor(session.method)}
            label={session.method}
            size="small"
            variant="filled"
          />
          <Typography noWrap variant="subtitle2">
            {session.path || "/"}
          </Typography>
          <Chip
            color={getStatusColor(session.statusCode)}
            label={String(session.statusCode)}
            size="small"
            variant="outlined"
          />
          <Typography color="text.secondary" noWrap variant="caption">
            {t("common.tech.milliseconds", { value: session.durationMs })} • {t("common.tech.bytes", { value: session.sizeBytes })}
          </Typography>
        </Stack>

        <Stack alignItems="center" direction="row" spacing={0.5}>
          {onRepeat ? (
            <Tooltip arrow title={t("inspector.summary.repeatInCompose")}>
              <Button
                onClick={onRepeat}
                size="small"
                startIcon={<ReplayRoundedIcon />}
                sx={{ minWidth: 0, px: 1.25 }}
                variant="text"
              >
                {t("common.actions.repeat")}
              </Button>
            </Tooltip>
          ) : null}
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(session.url);
            }}
            size="small"
            startIcon={<ContentCopyRoundedIcon />}
            sx={{ minWidth: 0, px: 1.25 }}
            variant="text"
          >
            {t("common.actions.copyUrl")}
          </Button>
        </Stack>
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
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? t("common.empty.noData")}
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
  headers?: [string, string] | [string, string, string];
}) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        overflow: "hidden",
      }}
    >
      {headers ? (
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
      ) : null}
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

export function EllipsizedCell({
  text,
}: {
  text: string;
}) {
  const { t } = useI18n();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  return (
    <>
      <Stack alignItems="center" direction="row" spacing={0.25} sx={{ minWidth: 0, width: "100%" }}>
        <Tooltip arrow enterDelay={350} placement="top-start" title={text}>
          <Typography sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} variant="body2">
            {text}
          </Typography>
        </Tooltip>
        {text.length > 80 ? (
          <Tooltip arrow title={t("inspector.copyFullValue")}>
            <IconButton
              onClick={(event) => setAnchorEl(event.currentTarget)}
              size="small"
              sx={{ color: "text.secondary", flex: "0 0 auto", p: 0.25 }}
            >
              <LaunchRoundedIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>

      <Popover
        anchorEl={anchorEl}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        onClose={() => setAnchorEl(null)}
        open={open}
        slotProps={{
          paper: {
            sx: {
              maxHeight: 420,
              maxWidth: 720,
              p: 1.25,
            },
          },
        }}
        transformOrigin={{ horizontal: "left", vertical: "top" }}
      >
        <Box
          component="pre"
          sx={{
            color: "text.primary",
            fontFamily: "JetBrains Mono, Consolas, monospace",
            fontSize: 12.5,
            lineHeight: 1.5,
            m: 0,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </Box>
      </Popover>
    </>
  );
}

export function InspectorKeyValueTable({
  emptyMessage,
  items,
}: {
  emptyMessage?: string;
  items: Array<[string, string]>;
}) {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? t("common.empty.noData")}
      </Typography>
    );
  }

  const columnTemplate = "minmax(156px, 0.84fr) minmax(0, 1.9fr)";

  return (
    <InspectorFlatTable columnTemplate={columnTemplate}>
      {items.map(([label, value], index) => (
        <InspectorFlatTableRow
          cells={[
            <Typography key="label" sx={{ minWidth: 0, wordBreak: "break-all" }} variant="body2">
              {label}
            </Typography>,
            <EllipsizedCell key="value" text={value} />,
          ]}
          columnTemplate={columnTemplate}
          dense
          hoverable
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
  const theme = useTheme();
  const syntaxColors = getSyntaxColors(theme.palette.mode);
  const jsonTokenColors = { ...syntaxColors, punctuation: "text.primary" } as const;

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
      {language === "json"
        ? renderJsonSyntaxHighlightedText(code, jsonTokenColors, searchQuery)
        : renderHighlightedText(code, searchQuery)}
    </Box>
  );
}

export function renderJsonSyntaxHighlightedText(
  text: string,
  tokenColors: ReturnType<typeof getSyntaxColors> & { punctuation: string },
  searchQuery?: string,
) {
  const tokenPattern = /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

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

  const segments: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = text.indexOf(normalizedQuery, cursor);

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
