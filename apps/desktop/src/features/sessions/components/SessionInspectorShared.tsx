import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import LaunchRoundedIcon from "@mui/icons-material/LaunchRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import { Box, Chip, IconButton, List, ListItem, Menu, MenuItem, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { getSyntaxColors } from "@/themes/app-theme";
import { appFontCssVars, defaultAppFontSize } from "@/themes/fonts";
import { findNormalizedMatchIndex, getMethodColor, getRequestOperationLabel, getStatusColor, hasPreviewableMediaMimeType, normalizeSearch, type SearchMatcher } from "./session-inspector.helpers";

const CODE_BLOCK_VIRTUALIZATION_CHAR_THRESHOLD = 48 * 1024;
const CODE_BLOCK_VIRTUALIZATION_LINE_THRESHOLD = 320;
export const JSON_HIGHLIGHT_CHAR_LIMIT = 12000;
const DEFAULT_VIRTUAL_VIEWPORT_HEIGHT = 420;
const VIRTUAL_WINDOW_OVERSCAN = 12;
export const INSPECTOR_KEY_VALUE_GRID_TEMPLATE = "minmax(156px, 0.7fr) minmax(0, 2.3fr)";
export const INSPECTOR_UI_FONT_SIZE = 13;
export const INSPECTOR_AUX_FONT_SIZE = 12;
export const INSPECTOR_CODE_FONT_SIZE = 12.5;
export function getWorkbenchFontSize(theme: Theme, basePx: number): string {
  return `${(theme.typography.fontSize / defaultAppFontSize) * basePx}px`;
}
export const inspectorTabsSx = {
  flex: 1,
  minHeight: 36,
  minWidth: 0,
  px: 0.75,
  "& .MuiTab-root": {
    borderRadius: 1,
    color: "text.secondary",
    fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
    fontWeight: 500,
    letterSpacing: 0,
    lineHeight: 1.25,
    minHeight: 30,
    mx: 0.125,
    px: 1.15,
    py: 0.75,
    transition: "background-color 140ms ease, color 140ms ease",
    "&:hover": {
      bgcolor: "action.hover",
      color: "text.primary",
    },
  },
  "& .MuiTab-root.Mui-selected": {
    color: "primary.main",
    bgcolor: "action.selected",
  },
  "& .MuiTabs-indicator": {
    display: "none",
  },
} as const;
export const inspectorPaneActionButtonSx = {
  color: "primary.main",
  fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
  fontWeight: 500,
  lineHeight: 1.25,
  minHeight: 30,
  minWidth: 0,
  px: 1.25,
  "& .MuiButton-startIcon": {
    mr: 0.5,
    "& > *:nth-of-type(1)": {
      fontSize: 18,
    },
  },
} as const;
export const inspectorKeyTypographySx = {
  color: "text.secondary",
  fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
  fontWeight: 400,
  lineHeight: 1.45,
  minWidth: 0,
} as const;
export const inspectorValueTypographySx = {
  color: "text.primary",
  fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
  fontWeight: 400,
  lineHeight: 1.45,
  minWidth: 0,
} as const;

export function InspectorSummaryBar({
  detail,
  onCopyCurl,
  onCopyUrl,
  onRepeat,
  session,
}: {
  detail: SessionDetail | undefined;
  onCopyCurl?: (() => void) | undefined;
  onCopyUrl?: (() => void) | undefined;
  onRepeat?: (() => void) | undefined;
  session: SessionSummary;
}) {
  const { t } = useI18n();
  const totalDuration = detail?.timing?.totalMs ?? session.durationMs;
  const isMediaResponse = hasPreviewableMediaMimeType(session.responseMimeType);
  const requestOperationLabel = isMediaResponse
    ? undefined
    : getRequestOperationLabel(detail, session);
  const summaryTitle = requestOperationLabel ?? session.path ?? session.url;
  const displayHost = session.host || (() => {
    try {
      return new URL(session.url).host;
    } catch {
      return "";
    }
  })();
  const displayPath = session.path || (() => {
    try {
      const parsedUrl = new URL(session.url);
      return `${parsedUrl.pathname}${parsedUrl.search}`;
    } catch {
      return session.url;
    }
  })();

  return (
    <Stack
      spacing={0.75}
      sx={(theme) => ({
        bgcolor: theme.palette.mode === "dark"
          ? alpha(theme.palette.background.default, 0.26)
          : alpha(theme.palette.background.default, 0.45),
        px: 2,
        py: 1.25,
      })}
    >
      <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={1.5}>
        <Stack alignItems="center" direction="row" spacing={1} sx={{ minWidth: 0 }}>
          <Tooltip arrow title={summaryTitle}>
            <Typography
              sx={{
                color: "text.primary",
                fontSize: (theme: Theme) => getWorkbenchFontSize(theme, 15),
                fontWeight: 650,
                lineHeight: 1.25,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              variant="subtitle2"
            >
              {summaryTitle}
            </Typography>
          </Tooltip>
          <Stack alignItems="center" direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
            {isMediaResponse ? null : (
              <Chip
                color={getMethodColor(session.method)}
                label={session.method.toUpperCase()}
                size="small"
                variant="filled"
              />
            )}
            <Chip
              color={getStatusColor(session.statusCode)}
              label={String(session.statusCode)}
              size="small"
              variant="outlined"
            />
            <Chip label={`${totalDuration}ms`} size="small" variant="outlined" />
          </Stack>
        </Stack>

        <Stack alignItems="center" direction="row" spacing={0.5}>
          {onRepeat ? (
            <Tooltip arrow title={t("inspector.summary.repeatInCompose")}>
              <IconButton
                aria-label={t("common.actions.repeat")}
                onClick={onRepeat}
                size="small"
                sx={{ p: 0.75 }}
              >
                <ReplayRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          {onCopyUrl ? (
            <Tooltip arrow title={t("common.actions.copyUrl")}>
              <IconButton
                aria-label={t("common.actions.copyUrl")}
                onClick={onCopyUrl}
                size="small"
                sx={{ p: 0.75 }}
              >
                <LinkRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          {onCopyCurl ? (
            <Tooltip arrow title={t("contextMenu.copyAsCurl")}>
              <IconButton
                aria-label={t("contextMenu.copyAsCurl")}
                onClick={onCopyCurl}
                size="small"
                sx={{ p: 0.75 }}
              >
                <TerminalRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
      </Stack>

      <Tooltip
        arrow
        slotProps={{
          tooltip: {
            sx: {
              maxWidth: 720,
              overflowWrap: "anywhere",
            },
          },
        }}
        title={session.url}
      >
        <Typography
          color="text.secondary"
          sx={{
            alignItems: "baseline",
            display: "flex",
            fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
            fontFamily: "inherit",
            lineHeight: 1.45,
            minWidth: 0,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
          variant="body2"
        >
          {displayHost ? (
            <Box
              component="span"
              sx={{
                color: "text.primary",
                flexShrink: 0,
                fontWeight: 500,
                maxWidth: "36%",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {displayHost}
            </Box>
          ) : null}
          {displayHost && displayPath ? " " : null}
          <Box
            component="span"
            sx={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {displayPath}
          </Box>
        </Typography>
      </Tooltip>
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
          sx={{ alignItems: "center", columnGap: 3, minHeight: 32, py: 0.5 }}
        >
          <Typography
            color="text.secondary"
            sx={{ ...inspectorKeyTypographySx, flex: "0 0 180px", pr: 1 }}
            variant="body2"
          >
            {label}
          </Typography>
          <Typography
            sx={{ ...inspectorValueTypographySx, flex: 1, wordBreak: "break-all" }}
            variant="body2"
          >
            {value}
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

export function InspectorScrollArea({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", pr: 1 }}>
      {children}
    </Box>
  );
}

export function InspectorFlatTable({
  children,
  columnTemplate,
  headers,
}: {
  children: React.ReactNode;
  columnTemplate: string;
  headers?: [string, string] | [string, string, string] | [string, string, string, string];
}) {
  return (
    <Box
      sx={{
        bgcolor: "transparent",
        overflow: "hidden",
      }}
    >
      {headers ? (
        <Box
          sx={{
            bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.04 : 0.035),
            borderRadius: 1,
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
                ...inspectorKeyTypographySx,
                fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_AUX_FONT_SIZE),
                fontWeight: 500,
                lineHeight: 1.25,
                px: 0.75,
                py: 0.375,
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
        minHeight: dense ? 30 : 32,
        ...(hoverable
          ? {
              borderRadius: 1,
              transition: "background-color 120ms ease",
              "&:hover": {
                bgcolor: "action.hover",
              },
              "&:hover .InspectorCellAction": {
                opacity: 1,
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
  isSubtle = false,
  isItalic = false,
  text,
}: {
  isSubtle?: boolean;
  isItalic?: boolean;
  text: string;
}) {
  const { t } = useI18n();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);
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
  }, [text]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text);
  }, [text]);

  return (
    <>
      <Stack alignItems="center" direction="row" spacing={0.25} sx={{ minWidth: 0, width: "100%" }}>
        <Tooltip arrow enterDelay={350} placement="top-start" title={isOverflowing ? text : ""}>
          <Typography
            ref={textRef}
            sx={{
              ...inspectorValueTypographySx,
              flex: 1,
              fontStyle: isItalic ? "italic" : undefined,
              opacity: isSubtle ? 0.82 : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            variant="body2"
          >
            {text}
          </Typography>
        </Tooltip>
        {text.length > 0 ? (
          <Tooltip arrow title={t("contextMenu.copy")}>
            <IconButton
              aria-label={t("contextMenu.copy")}
              className="InspectorCellAction"
              onClick={handleCopy}
              size="small"
              sx={{
                color: "text.secondary",
                flex: "0 0 auto",
                opacity: 0,
                p: 0.25,
                transition: "opacity 120ms ease, color 120ms ease",
                "&:focus-visible": { opacity: 1 },
                "&:hover": { color: "primary.main" },
              }}
            >
              <ContentCopyRoundedIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        ) : null}
        {text.length > 80 ? (
          <Tooltip arrow title={t("inspector.copyFullValue")}>
            <IconButton
              aria-label={t("inspector.copyFullValue")}
              className="InspectorCellAction"
              onClick={(event) => setAnchorEl(event.currentTarget)}
              size="small"
              sx={{
                color: "text.secondary",
                flex: "0 0 auto",
                opacity: 0,
                p: 0.25,
                transition: "opacity 120ms ease, color 120ms ease",
                "&:focus-visible": { opacity: 1 },
                "&:hover": { color: "primary.main" },
              }}
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
            fontFamily: appFontCssVars.content,
            fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_CODE_FONT_SIZE),
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

export type InspectorKeyValueItem = [string, string] | { name: string; value: string; isPseudo?: boolean | undefined };

function isPseudoItem(item: InspectorKeyValueItem): item is { name: string; value: string; isPseudo?: boolean } {
  return typeof item === "object" && !Array.isArray(item);
}

export function InspectorKeyValueTable({
  emptyMessage,
  items,
  title,
}: {
  emptyMessage?: string;
  items: Array<InspectorKeyValueItem>;
  title?: string;
}) {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <Stack spacing={0.75}>
        {title ? (
          <Typography
            sx={{
              color: "text.secondary",
              fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_AUX_FONT_SIZE),
              fontWeight: 700,
              letterSpacing: 0,
              textTransform: "uppercase",
            }}
            variant="overline"
          >
            {title}
          </Typography>
        ) : null}
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? t("common.empty.noData")}
      </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={0.75}>
      {title ? (
        <Typography
          sx={{
            color: "text.secondary",
            fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_AUX_FONT_SIZE),
            fontWeight: 700,
            letterSpacing: 0,
            textTransform: "uppercase",
          }}
          variant="overline"
        >
          {title}
        </Typography>
      ) : null}
    <InspectorFlatTable columnTemplate={INSPECTOR_KEY_VALUE_GRID_TEMPLATE}>
      {items.map((item, index) => {
        const isPseudo = isPseudoItem(item) && item.isPseudo === true;
        const label = Array.isArray(item) ? item[0] : item.name;
        const value = Array.isArray(item) ? item[1] : item.value;

        return (
          <InspectorFlatTableRow
            cells={[
              <Typography
                key="label"
                sx={{
                  ...inspectorKeyTypographySx,
                  alignItems: "center",
                  display: "flex",
                  gap: 0.5,
                  ...(isPseudo ? { fontStyle: "italic", opacity: 0.86 } : {}),
                  wordBreak: "break-all",
                }}
                variant="body2"
              >
                <Box component="span" sx={{ minWidth: 0 }}>
                  {label}
                </Box>
                {isPseudo ? (
                  <Chip
                    label="pseudo"
                    size="small"
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: 0.75,
                      color: "text.disabled",
                      fontSize: (theme: Theme) => getWorkbenchFontSize(theme, 10.5),
                      fontStyle: "normal",
                      fontWeight: 600,
                      height: 18,
                      letterSpacing: 0,
                      ml: 0.25,
                      "& .MuiChip-label": {
                        px: 0.5,
                      },
                    }}
                    variant="filled"
                  />
                ) : null}
              </Typography>,
              <EllipsizedCell isItalic={isPseudo} isSubtle={isPseudo} key="value" text={value} />,
            ]}
            columnTemplate={INSPECTOR_KEY_VALUE_GRID_TEMPLATE}
            dense
            hoverable
            key={`${label}:${value}:${index}`}
          />
        );
      })}
    </InspectorFlatTable>
    </Stack>
  );
}

export function SearchableCodeBlock({
  code,
  currentMatchIndex,
  language = "plain",
  matcher,
  onMatchCountChange,
  onSearchWithText,
  searchQuery,
}: {
  code: string;
  currentMatchIndex?: number | undefined;
  language?: "json" | "plain";
  matcher?: SearchMatcher | null | undefined;
  onMatchCountChange?: ((count: number) => void) | undefined;
  onSearchWithText?: ((text: string) => void) | undefined;
  searchQuery: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const paletteMode = theme.palette.mode;
  const jsonTokenColors = useMemo(
    () => {
      const colors = getSyntaxColors(paletteMode);
      return { ...colors, punctuation: "text.primary" } as const;
    },
    [paletteMode],
  );
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const containerRef = useRef<HTMLPreElement | HTMLDivElement | null>(null);
  const shouldVirtualize = useMemo(
    () => shouldVirtualizeCodeBlock(code),
    [code],
  );

  const [contextMenu, setContextMenu] = useState<{
    anchorPosition: { left: number; top: number };
    selectedText: string;
  } | null>(null);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText) return;
    setContextMenu({
      anchorPosition: { left: event.clientX - 2, top: event.clientY - 4 },
      selectedText,
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);

  const handleCopySelection = useCallback(async () => {
    if (!contextMenu?.selectedText) return;
    await navigator.clipboard?.writeText(contextMenu.selectedText);
    setContextMenu(null);
  }, [contextMenu]);

  const handleSearchSelection = useCallback(() => {
    if (!contextMenu?.selectedText) return;
    onSearchWithText?.(contextMenu.selectedText);
    setContextMenu(null);
  }, [contextMenu, onSearchWithText]);

  const effectiveLanguage = language;

  const allMatches = useMemo(() => {
    if (!matcher) return [];
    return matcher(code);
  }, [code, matcher]);

  const currentMatchRange = useMemo(() => {
    if (!matcher || allMatches.length === 0 || currentMatchIndex === undefined) return null;
    return allMatches[currentMatchIndex] ?? null;
  }, [allMatches, currentMatchIndex, matcher]);

  useEffect(() => {
    if (onMatchCountChange) {
      onMatchCountChange(allMatches.length);
    }
  }, [allMatches.length, matcher, onMatchCountChange]);

  useEffect(() => {
    if (shouldVirtualize || !matcher) {
      return;
    }

    if (currentMatchIndex === undefined || allMatches.length === 0) {
      const firstMatch = containerRef.current?.querySelector("mark");
      if (firstMatch instanceof HTMLElement) {
        firstMatch.scrollIntoView({ block: "center" });
      }
      return;
    }

    const targetMatch = allMatches[currentMatchIndex];
    if (!targetMatch) return;

    const el = containerRef.current?.querySelector(`mark[data-match-index="${targetMatch.start}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center" });
    }
  }, [allMatches, code, currentMatchIndex, matcher, shouldVirtualize]);

  const codeBlockContent = shouldVirtualize ? (
    <VirtualizedSearchableCodeBlock
      code={code}
      currentMatchIndex={currentMatchIndex}
      language={effectiveLanguage}
      matcher={matcher}
      onContextMenu={handleContextMenu}
      onMatchCountChange={onMatchCountChange}
      searchQuery={deferredSearchQuery}
      tokenColors={jsonTokenColors}
    />
  ) : (
    <Box
      component="pre"
      ref={containerRef}
      onContextMenu={handleContextMenu}
      sx={{
        bgcolor: "transparent",
        color: "text.primary",
        flex: 1,
        fontFamily: appFontCssVars.content,
        fontSize: (theme: Theme) => getWorkbenchFontSize(theme, effectiveLanguage === "json" ? INSPECTOR_UI_FONT_SIZE : INSPECTOR_CODE_FONT_SIZE),
        lineHeight: effectiveLanguage === "json" ? 1.55 : 1.5,
        m: 0,
        minHeight: 0,
        overflow: "auto",
        overflowX: "auto",
        px: 0.75,
        py: 0.25,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {matcher
        ? effectiveLanguage === "json"
          ? renderJsonSyntaxHighlightedText(code, jsonTokenColors, undefined, matcher, currentMatchRange)
          : renderHighlightedText(code, undefined, matcher, currentMatchRange)
        : effectiveLanguage === "json"
          ? renderJsonSyntaxHighlightedText(code, jsonTokenColors, deferredSearchQuery)
          : renderHighlightedText(code, deferredSearchQuery)}
    </Box>
  );

  return (
    <>
      {codeBlockContent}
      <Menu
        anchorReference="anchorPosition"
        anchorPosition={contextMenu?.anchorPosition}
        onClose={handleCloseContextMenu}
        open={Boolean(contextMenu)}
        slotProps={{
          paper: {
            sx: {
              backgroundImage: "none",
              backdropFilter: "blur(20px)",
              backgroundColor: (theme: Theme) => theme.palette.mode === "dark"
                ? "rgba(32,32,32,0.88)"
                : "rgba(255,255,255,0.88)",
              borderRadius: 1.5,
              boxShadow: (theme: Theme) =>
                theme.palette.mode === "dark"
                  ? "0 8px 32px rgba(0,0,0,0.48), 0 1px 0 rgba(255,255,255,0.08) inset"
                  : "0 8px 32px rgba(0,0,0,0.12), 0 1px 0 rgba(255,255,255,0.56) inset",
              minWidth: 148,
              px: 0.5,
              py: 0.5,
            },
          },
        }}
      >
        <MenuItem
          onClick={handleCopySelection}
          sx={{
            borderRadius: 1,
            fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
            fontWeight: 400,
            gap: 1.5,
            minHeight: 30,
            px: 1.25,
            py: 0.75,
          }}
        >
          <ContentCopyRoundedIcon sx={{ fontSize: 17 }} />
          {t("contextMenu.copy")}
        </MenuItem>
        {onSearchWithText ? (
          <MenuItem
            onClick={handleSearchSelection}
            sx={{
              borderRadius: 1,
              fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
              fontWeight: 400,
              gap: 1.5,
              minHeight: 30,
              px: 1.25,
              py: 0.75,
            }}
          >
            <SearchRoundedIcon sx={{ fontSize: 17 }} />
            {t("contextMenu.search")}
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

export function useVirtualWindow(itemCount: number, itemHeight: number, overscan = VIRTUAL_WINDOW_OVERSCAN) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIRTUAL_VIEWPORT_HEIGHT);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const updateMetrics = () => {
      setScrollTop(container.scrollTop);
      setViewportHeight(container.clientHeight || DEFAULT_VIRTUAL_VIEWPORT_HEIGHT);
    };

    updateMetrics();
    container.addEventListener("scroll", updateMetrics, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      return () => {
        container.removeEventListener("scroll", updateMetrics);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateMetrics();
    });
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("scroll", updateMetrics);
      resizeObserver.disconnect();
    };
  }, []);

  const totalHeight = itemCount * itemHeight;
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / itemHeight));
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(itemCount, startIndex + visibleCount + overscan * 2);

  return {
    containerRef,
    endIndex,
    offsetTop: startIndex * itemHeight,
    startIndex,
    totalHeight,
  };
}

function VirtualizedSearchableCodeBlock({
  code,
  currentMatchIndex,
  language,
  matcher,
  onContextMenu,
  onMatchCountChange,
  searchQuery,
  tokenColors,
}: {
  code: string;
  currentMatchIndex?: number | undefined;
  language: "json" | "plain";
  matcher?: SearchMatcher | null | undefined;
  onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  onMatchCountChange?: ((count: number) => void) | undefined;
  searchQuery: string;
  tokenColors: ReturnType<typeof getSyntaxColors> & { punctuation: string };
}) {
  const MAX_LINE_CHARS = 500;
  const lines = useMemo(() => {
    const rawLines = code.split(/\r?\n/);
    const result: string[] = [];
    for (const line of rawLines) {
      if (line.length <= MAX_LINE_CHARS) {
        result.push(line);
      } else {
        for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
          result.push(line.slice(i, i + MAX_LINE_CHARS));
        }
      }
    }
    return result;
  }, [code]);
  const lineHeight = language === "json" ? 21 : 20;
  const { containerRef: virtualContainerRef, endIndex, offsetTop, startIndex, totalHeight } = useVirtualWindow(lines.length, lineHeight);
  const visibleLines = lines.slice(startIndex, endIndex);

  const [measuredContentWidth, setMeasuredContentWidth] = useState(0);

  useEffect(() => {
    const container = virtualContainerRef.current;
    if (!container || lines.length === 0) return;
    const computedStyle = window.getComputedStyle(container);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = computedStyle.font;
    let maxW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxW) maxW = w;
    }
    setMeasuredContentWidth(Math.ceil(maxW));
  }, [lines]);

  const lineMatchInfo = useMemo(() => {
    if (!matcher) return { totalMatches: 0, lineOffsets: [] as number[], matchLineIndex: -1 };
    let totalMatches = 0;
    const lineOffsets: number[] = [];
    let targetLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const matches = matcher(lines[i] ?? "");
      const count = matches.length;
      lineOffsets.push(totalMatches);
      totalMatches += count;

      if (targetLineIndex === -1 && currentMatchIndex !== undefined && currentMatchIndex < totalMatches) {
        targetLineIndex = i;
      }
    }

    return { totalMatches, lineOffsets, matchLineIndex: targetLineIndex };
  }, [currentMatchIndex, lines, matcher]);

  useEffect(() => {
    if (onMatchCountChange) {
      onMatchCountChange(lineMatchInfo.totalMatches);
    }
  }, [lineMatchInfo.totalMatches, matcher, onMatchCountChange]);

  const firstMatchingLineIndex = useMemo(
    () => {
      if (matcher && lineMatchInfo.matchLineIndex !== -1) return lineMatchInfo.matchLineIndex;
      return findFirstMatchingLineIndex(lines, searchQuery);
    },
    [lineMatchInfo.matchLineIndex, lines, matcher, searchQuery],
  );

  useEffect(() => {
    const container = virtualContainerRef.current;

    if (!container || firstMatchingLineIndex === -1) {
      return;
    }

    const centeredScrollTop = Math.max(
      0,
      firstMatchingLineIndex * lineHeight - Math.max(0, container.clientHeight - lineHeight) / 2,
    );

    container.scrollTop = centeredScrollTop;
    container.dispatchEvent(new Event("scroll"));
  }, [firstMatchingLineIndex, lineHeight, virtualContainerRef]);

  return (
    <Box
      ref={virtualContainerRef}
      onContextMenu={onContextMenu}
      sx={{
        bgcolor: "transparent",
        color: "text.primary",
        flex: 1,
        fontFamily: appFontCssVars.content,
        fontSize: (theme: Theme) => getWorkbenchFontSize(theme, language === "json" ? INSPECTOR_UI_FONT_SIZE : INSPECTOR_CODE_FONT_SIZE),
        lineHeight: language === "json" ? 1.55 : 1.5,
        minHeight: 0,
        overflow: "auto",
        px: 0.75,
        py: 0.25,
        whiteSpace: "pre",
      }}
    >
      <Box sx={{ height: totalHeight, minWidth: "100%", position: "relative", width: measuredContentWidth > 0 ? measuredContentWidth : "max-content" }}>
        <Box sx={{ left: 0, position: "absolute", right: 0, top: offsetTop }}>
          {visibleLines.map((line, visibleIndex) => {
            const lineContent =
              line.length === 0
                ? "\u00A0"
                : matcher
                  ? language === "json"
                    ? renderJsonSyntaxHighlightedText(line, tokenColors, undefined, matcher)
                    : renderHighlightedText(line, undefined, matcher)
                  : language === "json"
                    ? renderJsonSyntaxHighlightedText(line, tokenColors, searchQuery)
                    : renderHighlightedText(line, searchQuery);

            return (
              <Box
                component="div"
                key={startIndex + visibleIndex}
                sx={{
                  height: lineHeight,
                  minWidth: "100%",
                  whiteSpace: "pre",
                }}
              >
                {lineContent}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function shouldVirtualizeCodeBlock(code: string) {
  if (code.length >= CODE_BLOCK_VIRTUALIZATION_CHAR_THRESHOLD) {
    return true;
  }

  let lineCount = 1;

  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "\n") {
      lineCount += 1;
    }

    if (lineCount >= CODE_BLOCK_VIRTUALIZATION_LINE_THRESHOLD) {
      return true;
    }
  }

  return false;
}

function findFirstMatchingLineIndex(lines: string[], searchQuery: string) {
  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return -1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (findNormalizedMatchIndex(lines[index] ?? "", normalizedQuery) !== -1) {
      return index;
    }
  }

  return -1;
}

export function renderJsonSyntaxHighlightedText(
  text: string,
  tokenColors: ReturnType<typeof getSyntaxColors> & { punctuation: string },
  searchQuery?: string,
  matcher?: SearchMatcher | null | undefined,
  currentMatchRange?: { start: number; end: number } | null | undefined,
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
          {renderHighlightedText(stringToken, searchQuery, matcher, currentMatchRange)}
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
          {renderHighlightedText(matchedText, searchQuery, matcher, currentMatchRange)}
        </Box>,
      );
    } else if (matchedText === "null") {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.null }}>
          {renderHighlightedText(matchedText, searchQuery, matcher, currentMatchRange)}
        </Box>,
      );
    } else if (/^-?\d/.test(matchedText)) {
      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.number }}>
          {renderHighlightedText(matchedText, searchQuery, matcher, currentMatchRange)}
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

export function renderHighlightedText(
  text: string,
  searchQuery?: string,
  matcher?: SearchMatcher | null | undefined,
  currentMatchRange?: { start: number; end: number } | null | undefined,
) {
  if (matcher) {
    const matches = matcher(text);
    if (matches.length === 0) {
      return text;
    }

    const segments: React.ReactNode[] = [];
    let cursor = 0;

    for (const match of matches) {
      if (match.start > cursor) {
        segments.push(text.slice(cursor, match.start));
      }

      const isCurrent = currentMatchRange && currentMatchRange.start === match.start && currentMatchRange.end === match.end;
      segments.push(
        <Box
          component="mark"
          data-match-index={match.start}
          key={`${match.start}-${match.end}`}
          sx={{
            bgcolor: isCurrent ? "warning.dark" : "warning.light",
            color: isCurrent ? "warning.contrastText" : undefined,
            px: 0.25,
          }}
        >
          {text.slice(match.start, match.end)}
        </Box>,
      );
      cursor = match.end;
    }

    if (cursor < text.length) {
      segments.push(text.slice(cursor));
    }

    return segments.map((segment, index) => <Fragment key={index}>{segment}</Fragment>);
  }

  const normalizedQuery = normalizeSearch(searchQuery);

  if (!normalizedQuery) {
    return text;
  }

  const segments: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = findNormalizedMatchIndex(text, normalizedQuery, cursor);

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
