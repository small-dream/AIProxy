import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import LaunchRoundedIcon from "@mui/icons-material/LaunchRounded";
import LinkRoundedIcon from "@mui/icons-material/LinkRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import {
  Box,
  Chip,
  IconButton,
  List,
  ListItem,
  Menu,
  MenuItem,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import type { SxProps, Theme } from "@mui/material/styles";
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { getSelectionHighlightColor, getSyntaxColors } from "@/themes/app-theme";
import { appFontCssVars, defaultAppFontSize } from "@/themes/fonts";
import {
  findJsonTextToken,
  resolveJsonTextLine,
  resolveJsonTextPath,
} from "./json-text-token.helpers";
import {
  findNormalizedMatchIndex,
  getMethodColor,
  getRequestOperationLabel,
  getStatusColor,
  hasPreviewableMediaMimeType,
  isClientCancelledStatus,
  normalizeSearch,
  type SearchMatcher,
} from "./session-inspector.helpers";

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
  const durationLabel =
    totalDuration === 0
      ? t("common.tech.lessThanMillisecond")
      : t("common.tech.milliseconds", { value: totalDuration });
  const statusLabel = isClientCancelledStatus(session.statusCode)
    ? `${t("inspector.request.overview.cancelled")} ${session.statusCode}`
    : String(session.statusCode);
  const isMediaResponse = hasPreviewableMediaMimeType(session.responseMimeType);
  const requestOperationLabel = isMediaResponse
    ? undefined
    : getRequestOperationLabel(detail, session);
  const summaryTitle = requestOperationLabel ?? session.path ?? session.url;
  const displayHost =
    session.host ||
    (() => {
      try {
        return new URL(session.url).host;
      } catch {
        return "";
      }
    })();
  const displayPath =
    session.path ||
    (() => {
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
        bgcolor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.default, 0.26)
            : alpha(theme.palette.background.default, 0.45),
        px: 2,
        py: 1.25,
      })}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          minWidth: 0,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            flex: "1 1 0",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <Tooltip arrow title={summaryTitle}>
            <Typography
              sx={{
                color: "text.primary",
                flex: "1 1 auto",
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
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <Chip color="warning" label={durationLabel} size="small" variant="outlined" />
            {isMediaResponse ? null : (
              <Chip
                color={getMethodColor(session.method)}
                label={session.method.toUpperCase()}
                size="small"
                variant="outlined"
              />
            )}
            <Chip
              color={getStatusColor(session.statusCode)}
              label={statusLabel}
              size="small"
              variant="outlined"
            />
          </Stack>
        </Stack>

        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            alignItems: "center",
            flex: "0 0 auto",
          }}
        >
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
          variant="body2"
          sx={{
            color: "text.secondary",
            alignItems: "baseline",
            display: "flex",
            fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
            fontFamily: "inherit",
            lineHeight: 1.45,
            minWidth: 0,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
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
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
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
            variant="body2"
            sx={{
              ...inspectorKeyTypographySx,
              flex: "0 0 180px",
              pr: 1,
            }}
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

export function InspectorScrollArea({ children }: { children: React.ReactNode }) {
  return <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", pr: 1 }}>{children}</Box>;
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
            bgcolor: (theme) =>
              alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.04 : 0.035),
            borderRadius: 1,
            display: "grid",
            gridTemplateColumns: columnTemplate,
            minHeight: 20,
          }}
        >
          {headers.map((header) => (
            <Typography
              key={header}
              variant="caption"
              sx={{
                ...inspectorKeyTypographySx,
                fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_AUX_FONT_SIZE),
                fontWeight: 500,
                lineHeight: 1.25,
                px: 0.75,
                py: 0.375,
              }}
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
      <Stack
        direction="row"
        spacing={0.25}
        sx={{
          alignItems: "center",
          minWidth: 0,
          width: "100%",
        }}
      >
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

export type InspectorKeyValueItem =
  | [string, string]
  | { name: string; value: string; isPseudo?: boolean | undefined };

function isPseudoItem(
  item: InspectorKeyValueItem,
): item is { name: string; value: string; isPseudo?: boolean } {
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
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
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
                      label={t("inspector.pseudo")}
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

type JsonTextMenuToken = {
  copyText: string;
  isKey: boolean;
  path: string | null;
  /** Body offsets of the token the actions target, used to outline it. */
  range: TextRange;
  searchText: string;
};

type TextRange = { start: number; end: number };

type TextScope = { element: HTMLElement; start: number };

function asHtmlElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}

/**
 * Map a pointer position to a character offset in the rendered text. The
 * virtualized code block renders one element per line, so an offset inside a
 * line is rebased onto that line's absolute start in the source text.
 */
function resolveTextOffsetFromPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const caretRange = getCaretRangeFromPoint(clientX, clientY);
  if (!caretRange) {
    return null;
  }

  return measureTextLength(
    findOwningTextScope(container, caretRange.startContainer),
    caretRange.startContainer,
    caretRange.startOffset,
  );
}

function getCaretRangeFromPoint(clientX: number, clientY: number): Range | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  // WebKit (macOS/Linux) and Chromium (Windows) ship caretRangeFromPoint;
  // Firefox exposes the standardised caretPositionFromPoint instead.
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range) {
    return range;
  }

  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  if (!position) {
    return null;
  }

  const fallback = document.createRange();
  fallback.setStart(position.offsetNode, position.offset);
  fallback.collapse(true);
  return fallback;
}

function findOwningTextScope(container: HTMLElement, node: Node): TextScope | null {
  if (!container.contains(node)) {
    return null;
  }

  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const lineElement = element?.closest<HTMLElement>("[data-line-start]");

  if (lineElement && container.contains(lineElement)) {
    const start = Number(lineElement.dataset.lineStart);

    if (!Number.isFinite(start)) {
      return null;
    }

    return { element: lineElement, start };
  }

  // A virtualized block only renders the visible lines, so an offset measured
  // against the container itself would be wrong; the pointer must land on one
  // of the rendered lines.
  return container.querySelector("[data-line-start]") ? null : { element: container, start: 0 };
}

function measureTextLength(scope: TextScope | null, node: Node, offset: number): number | null {
  if (!scope) {
    return null;
  }

  const range = document.createRange();

  try {
    range.setStart(scope.element, 0);
    range.setEnd(node, offset);
  } catch {
    return null;
  }

  return scope.start + range.toString().length;
}

function selectTextRange(container: HTMLElement, start: number, end: number) {
  const selection = window.getSelection();

  if (!selection || typeof selection.removeAllRanges !== "function") {
    return;
  }

  const range = createRangeForTextOffsets(container, start, end);
  if (!range) {
    return;
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function createRangeForTextOffsets(
  container: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const startPoint = resolveTextPointForOffset(container, start);
  const endPoint = resolveTextPointForOffset(container, end);

  if (!startPoint || !endPoint) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function resolveTextPointForOffset(
  container: HTMLElement,
  absoluteOffset: number,
): { node: Node; offset: number } | null {
  for (const scope of getTextScopes(container)) {
    const length = scope.element.textContent?.length ?? 0;

    if (absoluteOffset < scope.start || absoluteOffset > scope.start + length) {
      continue;
    }

    const walker = document.createTreeWalker(scope.element, NodeFilter.SHOW_TEXT);
    let remaining = absoluteOffset - scope.start;
    let node = walker.nextNode();

    while (node) {
      const nodeLength = node.textContent?.length ?? 0;

      if (remaining <= nodeLength) {
        return { node, offset: remaining };
      }

      remaining -= nodeLength;
      node = walker.nextNode();
    }

    return null;
  }

  return null;
}

function getTextScopes(container: HTMLElement): TextScope[] {
  const lineElements = Array.from(container.querySelectorAll<HTMLElement>("[data-line-start]"));

  if (lineElements.length === 0) {
    return [{ element: container, start: 0 }];
  }

  return lineElements.map((element) => ({
    element,
    start: Number(element.dataset.lineStart),
  }));
}

/**
 * Map the native selection onto body-absolute text offsets when both ends live
 * inside `container`. Collapsed, foreign and engine-less selections (jsdom and
 * other headless runtimes) resolve to `null`.
 */
function resolveTextRangeFromSelection(container: HTMLElement): TextRange | null {
  const selection = window.getSelection();

  if (!selection || typeof selection.getRangeAt !== "function" || selection.isCollapsed) {
    return null;
  }

  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  if (
    !range ||
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const start = measureTextLength(
    findOwningTextScope(container, range.startContainer),
    range.startContainer,
    range.startOffset,
  );
  const end = measureTextLength(
    findOwningTextScope(container, range.endContainer),
    range.endContainer,
    range.endOffset,
  );

  if (start === null || end === null || end <= start) {
    return null;
  }

  return { start, end };
}

/**
 * Drop the native selection that belongs to `container`. The context menu
 * paints the captured range itself, so an engine that keeps the platform
 * selection alive while the menu owns focus would otherwise double the colour.
 */
function clearNativeSelection(container: HTMLElement) {
  const selection = window.getSelection();

  if (!selection || typeof selection.removeAllRanges !== "function") {
    return;
  }

  const anchor = selection.anchorNode;

  if (!anchor || container.contains(anchor)) {
    selection.removeAllRanges();
  }
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
  const effectiveLanguage = language;
  const isJsonLanguage = effectiveLanguage === "json";
  const jsonTokenColors = useMemo(() => {
    const colors = getSyntaxColors(paletteMode);
    return { ...colors, punctuation: "text.primary" } as const;
  }, [paletteMode]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const containerRef = useRef<HTMLPreElement | HTMLDivElement | null>(null);
  const shouldVirtualize = useMemo(() => shouldVirtualizeCodeBlock(code), [code]);

  const [contextMenu, setContextMenu] = useState<{
    anchorPosition: { left: number; top: number };
    /** Element that owns the selection, used to restore it after the menu. */
    container: HTMLElement | null;
    /** Platform selection captured when the menu opened. */
    highlightRange: TextRange | null;
    selectedText: string;
    token: JsonTextMenuToken | null;
  } | null>(null);
  const restoreSelectionRef = useRef<{ container: HTMLElement; range: TextRange } | null>(null);

  // The JSON text views are highlight-only, so the pointer is the only reliable
  // anchor: resolve the semantic token under it instead of trusting the char
  // range the browser would pick on a double-click.
  const resolveTokenAtEvent = useCallback(
    (event: React.MouseEvent): JsonTextMenuToken | null => {
      if (!isJsonLanguage) {
        return null;
      }

      const container = asHtmlElement(event.currentTarget);
      const offset = container
        ? resolveTextOffsetFromPoint(container, event.clientX, event.clientY)
        : null;
      if (!container || offset === null) {
        return null;
      }

      const token = findJsonTextToken(code, offset);
      if (!token) {
        return null;
      }

      return {
        copyText: token.copyText,
        isKey: token.kind === "key",
        path: resolveJsonTextPath(code, token.start),
        range: { start: token.selectStart, end: token.selectEnd },
        searchText: token.searchText,
      };
    },
    [code, isJsonLanguage],
  );

  const resolveSelectionAtEvent = useCallback(
    (event: React.MouseEvent, granularity: "token" | "line") => {
      if (!isJsonLanguage) {
        return null;
      }

      // Leave modified double-clicks (Option/Shift word select, Cmd link click)
      // to the platform.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return null;
      }

      const container = asHtmlElement(event.currentTarget);
      const offset = container
        ? resolveTextOffsetFromPoint(container, event.clientX, event.clientY)
        : null;
      if (!container || offset === null) {
        return null;
      }

      if (granularity === "line") {
        return resolveJsonTextLine(code, offset);
      }

      const token = findJsonTextToken(code, offset);
      return token ? { start: token.selectStart, end: token.selectEnd } : null;
    },
    [code, isJsonLanguage],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const container = asHtmlElement(event.currentTarget);
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() ?? "";
      const token = resolveTokenAtEvent(event);

      if (!selectedText && !token) {
        return;
      }

      const highlightRange = container ? resolveTextRangeFromSelection(container) : null;

      // The menu paints the captured range itself: the platform selection is
      // dropped here so engines that keep it alive under the menu do not end up
      // drawing a second, darker highlight on top of it.
      if (container && highlightRange) {
        clearNativeSelection(container);
      }

      setContextMenu({
        anchorPosition: { left: event.clientX - 2, top: event.clientY - 4 },
        container,
        highlightRange,
        selectedText,
        token,
      });
    },
    [resolveTokenAtEvent],
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const container = asHtmlElement(event.currentTarget);
      const range = resolveSelectionAtEvent(event, "token");

      if (container && range) {
        selectTextRange(container, range.start, range.end);
      }
    },
    [resolveSelectionAtEvent],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.detail !== 3) {
        return;
      }

      const container = asHtmlElement(event.currentTarget);
      const range = resolveSelectionAtEvent(event, "line");

      if (container && range) {
        selectTextRange(container, range.start, range.end);
      }
    },
    [resolveSelectionAtEvent],
  );

  /**
   * Close the menu, keeping the selection the user had when it opened. Copying
   * or dismissing with Escape should leave the text selected, while a click
   * outside keeps the platform behaviour of dropping it.
   */
  const closeContextMenu = useCallback(
    (restoreSelection: boolean) => {
      if (restoreSelection && contextMenu?.container && contextMenu.highlightRange) {
        restoreSelectionRef.current = {
          container: contextMenu.container,
          range: contextMenu.highlightRange,
        };
      }

      setContextMenu(null);
    },
    [contextMenu],
  );

  const handleCloseContextMenu = useCallback(
    (_event: unknown, reason: string) => closeContextMenu(reason !== "backdropClick"),
    [closeContextMenu],
  );

  const copyContextText = useCallback(
    async (text: string | undefined) => {
      if (!text) return;
      await navigator.clipboard?.writeText(text);
      closeContextMenu(true);
    },
    [closeContextMenu],
  );

  const handleCopySelection = useCallback(
    () => copyContextText(contextMenu?.selectedText),
    [contextMenu?.selectedText, copyContextText],
  );

  const handleCopyTokenText = useCallback(
    () => copyContextText(contextMenu?.token?.copyText),
    [contextMenu?.token?.copyText, copyContextText],
  );

  const handleCopyTokenPath = useCallback(
    () => copyContextText(contextMenu?.token?.path ?? undefined),
    [contextMenu?.token?.path, copyContextText],
  );

  const handleSearch = useCallback(() => {
    const searchText = contextMenu?.selectedText || contextMenu?.token?.searchText;
    if (!searchText) return;
    onSearchWithText?.(searchText);
    closeContextMenu(true);
  }, [
    closeContextMenu,
    contextMenu?.selectedText,
    contextMenu?.token?.searchText,
    onSearchWithText,
  ]);

  // The menu wrapper clears the very selection the range was captured from, and
  // the modal teardown runs after it. Re-applying it here keeps Cmd+C working
  // and hands the highlight back to the platform once the menu is gone.
  useEffect(() => {
    const pending = restoreSelectionRef.current;

    if (contextMenu || !pending) {
      return;
    }

    restoreSelectionRef.current = null;
    selectTextRange(pending.container, pending.range.start, pending.range.end);
  }, [contextMenu]);

  // A new body invalidates every captured offset, so the menu closes instead of
  // acting on a range that no longer lines up with the rendered text.
  useEffect(() => {
    restoreSelectionRef.current = null;
    setContextMenu(null);
  }, [code]);

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

  // While the menu is open the block owns the highlight: the captured platform
  // selection when there is one, otherwise the token the actions will target.
  const menuHighlightRange = contextMenu
    ? (contextMenu.highlightRange ?? contextMenu.token?.range ?? null)
    : null;

  const codeBlockContent = shouldVirtualize ? (
    <VirtualizedSearchableCodeBlock
      code={code}
      currentMatchIndex={currentMatchIndex}
      highlightRange={menuHighlightRange}
      language={effectiveLanguage}
      matcher={matcher}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      onMatchCountChange={onMatchCountChange}
      searchQuery={deferredSearchQuery}
      tokenColors={jsonTokenColors}
    />
  ) : (
    <Box
      component="pre"
      ref={containerRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      sx={{
        bgcolor: "transparent",
        color: "text.primary",
        flex: 1,
        fontFamily: appFontCssVars.content,
        fontSize: (theme: Theme) =>
          getWorkbenchFontSize(
            theme,
            effectiveLanguage === "json" ? INSPECTOR_UI_FONT_SIZE : INSPECTOR_CODE_FONT_SIZE,
          ),
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
          ? renderJsonSyntaxHighlightedText(
              code,
              jsonTokenColors,
              undefined,
              matcher,
              currentMatchRange,
              0,
              allMatches,
              menuHighlightRange,
            )
          : renderHighlightedText(
              code,
              undefined,
              matcher,
              currentMatchRange,
              0,
              allMatches,
              menuHighlightRange,
            )
        : effectiveLanguage === "json"
          ? renderJsonSyntaxHighlightedText(
              code,
              jsonTokenColors,
              deferredSearchQuery,
              undefined,
              undefined,
              0,
              undefined,
              menuHighlightRange,
            )
          : renderHighlightedText(
              code,
              deferredSearchQuery,
              undefined,
              undefined,
              0,
              undefined,
              menuHighlightRange,
            )}
    </Box>
  );

  const codeBlockMenuItemSx: SxProps<Theme> = {
    borderRadius: 1,
    fontSize: (theme: Theme) => getWorkbenchFontSize(theme, INSPECTOR_UI_FONT_SIZE),
    fontWeight: 400,
    gap: 1.5,
    minHeight: 30,
    px: 1.25,
    py: 0.75,
  };

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
              backgroundColor: (theme: Theme) =>
                theme.palette.mode === "dark" ? "rgba(32,32,32,0.88)" : "rgba(255,255,255,0.88)",
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
        {contextMenu?.selectedText ? (
          // A snapped token selection is the same text as the token action, so
          // only keep the generic Copy when the user selected something else.
          contextMenu.selectedText === contextMenu.token?.copyText ? null : (
            <MenuItem onClick={handleCopySelection} sx={codeBlockMenuItemSx}>
              <ContentCopyRoundedIcon sx={{ fontSize: 17 }} />
              {t("contextMenu.copy")}
            </MenuItem>
          )
        ) : null}
        {contextMenu?.token ? (
          <MenuItem onClick={handleCopyTokenText} sx={codeBlockMenuItemSx}>
            <ContentCopyRoundedIcon sx={{ fontSize: 17 }} />
            {contextMenu.token.isKey ? t("inspector.json.copyKey") : t("inspector.json.copyValue")}
          </MenuItem>
        ) : null}
        {contextMenu?.token?.path ? (
          <MenuItem onClick={handleCopyTokenPath} sx={codeBlockMenuItemSx}>
            <ContentCopyRoundedIcon sx={{ fontSize: 17 }} />
            {t("inspector.json.copyPath")}
          </MenuItem>
        ) : null}
        {onSearchWithText ? (
          <MenuItem onClick={handleSearch} sx={codeBlockMenuItemSx}>
            <SearchRoundedIcon sx={{ fontSize: 17 }} />
            {t("contextMenu.search")}
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

export function useVirtualWindow(
  itemCount: number,
  itemHeight: number,
  overscan = VIRTUAL_WINDOW_OVERSCAN,
) {
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
  highlightRange,
  language,
  matcher,
  onClick,
  onContextMenu,
  onDoubleClick,
  onMatchCountChange,
  searchQuery,
  tokenColors,
}: {
  code: string;
  currentMatchIndex?: number | undefined;
  highlightRange?: TextRange | null | undefined;
  language: "json" | "plain";
  matcher?: SearchMatcher | null | undefined;
  onClick?: ((event: React.MouseEvent) => void) | undefined;
  onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  onDoubleClick?: ((event: React.MouseEvent) => void) | undefined;
  onMatchCountChange?: ((count: number) => void) | undefined;
  searchQuery: string;
  tokenColors: ReturnType<typeof getSyntaxColors> & { punctuation: string };
}) {
  const MAX_LINE_CHARS = 500;
  const { lines, lineStarts, maxLineLength } = useMemo(() => {
    const rawLines = code.split("\n");
    const result: string[] = [];
    const starts: number[] = [];
    let longestLineLength = 0;
    let lineOffset = 0;

    function pushLine(line: string, start: number) {
      result.push(line);
      starts.push(start);
      if (line.length > longestLineLength) {
        longestLineLength = line.length;
      }
    }

    for (const rawLine of rawLines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.length <= MAX_LINE_CHARS) {
        pushLine(line, lineOffset);
      } else {
        for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
          pushLine(line.slice(i, i + MAX_LINE_CHARS), lineOffset + i);
        }
      }

      // +1 for the "\n" removed by the split.
      lineOffset += rawLine.length + 1;
    }

    return { lines: result, lineStarts: starts, maxLineLength: longestLineLength };
  }, [code]);
  const lineHeight = language === "json" ? 21 : 20;
  const {
    containerRef: virtualContainerRef,
    endIndex,
    offsetTop,
    startIndex,
    totalHeight,
  } = useVirtualWindow(lines.length, lineHeight);
  const visibleLines = lines.slice(startIndex, endIndex);
  const stableContentWidth = maxLineLength > 0 ? `max(100%, ${maxLineLength + 2}ch)` : "100%";

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

      if (
        targetLineIndex === -1 &&
        currentMatchIndex !== undefined &&
        currentMatchIndex < totalMatches
      ) {
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

  const firstMatchingLineIndex = useMemo(() => {
    if (matcher && lineMatchInfo.matchLineIndex !== -1) return lineMatchInfo.matchLineIndex;
    return findFirstMatchingLineIndex(lines, searchQuery);
  }, [lineMatchInfo.matchLineIndex, lines, matcher, searchQuery]);

  // Only the visible lines exist in the DOM, so a line is decorated against the
  // absolute offsets it starts at and the highlight is clipped to that range.
  const renderLine = (line: string, lineStart: number): React.ReactNode => {
    if (matcher) {
      return language === "json"
        ? renderJsonSyntaxHighlightedText(
            line,
            tokenColors,
            undefined,
            matcher,
            undefined,
            lineStart,
            undefined,
            highlightRange,
          )
        : renderHighlightedText(
            line,
            undefined,
            matcher,
            undefined,
            lineStart,
            undefined,
            highlightRange,
          );
    }

    return language === "json"
      ? renderJsonSyntaxHighlightedText(
          line,
          tokenColors,
          searchQuery,
          undefined,
          undefined,
          lineStart,
          undefined,
          highlightRange,
        )
      : renderHighlightedText(
          line,
          searchQuery,
          undefined,
          undefined,
          lineStart,
          undefined,
          highlightRange,
        );
  };

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
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      sx={{
        bgcolor: "transparent",
        color: "text.primary",
        flex: 1,
        fontFamily: appFontCssVars.content,
        fontSize: (theme: Theme) =>
          getWorkbenchFontSize(
            theme,
            language === "json" ? INSPECTOR_UI_FONT_SIZE : INSPECTOR_CODE_FONT_SIZE,
          ),
        lineHeight: language === "json" ? 1.55 : 1.5,
        minHeight: 0,
        overflow: "auto",
        px: 0.75,
        py: 0.25,
        whiteSpace: "pre",
      }}
    >
      <Box
        sx={{
          height: totalHeight,
          minWidth: "100%",
          position: "relative",
          width: stableContentWidth,
        }}
      >
        <Box sx={{ left: 0, position: "absolute", right: 0, top: offsetTop }}>
          {visibleLines.map((line, visibleIndex) => {
            const lineStart = lineStarts[startIndex + visibleIndex] ?? 0;
            const lineContent = line.length === 0 ? "\u00A0" : renderLine(line, lineStart);

            return (
              <Box
                component="div"
                data-line-start={lineStart}
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
  matchOffset = 0,
  matches?: Array<{ start: number; end: number }> | undefined,
  highlightRange?: TextRange | null | undefined,
) {
  const tokenPattern =
    /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
  const segments: React.ReactNode[] = [];
  const absoluteMatches =
    matches ??
    (matcher
      ? matcher(text).map((match) => ({
          start: matchOffset + match.start,
          end: matchOffset + match.end,
        }))
      : null);
  let cursor = 0;
  let tokenIndex = 0;

  // Every token is painted on its own, so each chunk is decorated against the
  // same absolute offsets the matches and the highlight range are expressed in.
  const decorate = (chunk: string, chunkOffset: number): React.ReactNode =>
    absoluteMatches
      ? renderHighlightedTextWithAbsoluteMatches(
          chunk,
          absoluteMatches,
          currentMatchRange,
          chunkOffset,
          highlightRange,
        )
      : renderHighlightedText(
          chunk,
          searchQuery,
          undefined,
          undefined,
          chunkOffset,
          undefined,
          highlightRange,
        );

  for (const match of text.matchAll(tokenPattern)) {
    const matchedText = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > cursor) {
      segments.push(decorate(text.slice(cursor, matchIndex), matchOffset + cursor));
    }

    if (match[1]) {
      const stringToken = match[1];
      const hasColon = Boolean(match[2]);
      const tokenMatchOffset = matchOffset + matchIndex;

      segments.push(
        <Box
          component="span"
          key={`json-token-${tokenIndex++}`}
          sx={{ color: hasColon ? tokenColors.key : tokenColors.string }}
        >
          {decorate(stringToken, tokenMatchOffset)}
        </Box>,
      );

      if (hasColon) {
        const colonToken = match[2] ?? "";
        segments.push(
          <Box
            component="span"
            key={`json-token-${tokenIndex++}`}
            sx={{ color: tokenColors.punctuation }}
          >
            {decorate(colonToken, tokenMatchOffset + stringToken.length)}
          </Box>,
        );
      }
    } else if (matchedText === "true" || matchedText === "false") {
      const tokenMatchOffset = matchOffset + matchIndex;

      segments.push(
        <Box
          component="span"
          key={`json-token-${tokenIndex++}`}
          sx={{ color: tokenColors.boolean }}
        >
          {decorate(matchedText, tokenMatchOffset)}
        </Box>,
      );
    } else if (matchedText === "null") {
      const tokenMatchOffset = matchOffset + matchIndex;

      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.null }}>
          {decorate(matchedText, tokenMatchOffset)}
        </Box>,
      );
    } else if (/^-?\d/.test(matchedText)) {
      const tokenMatchOffset = matchOffset + matchIndex;

      segments.push(
        <Box component="span" key={`json-token-${tokenIndex++}`} sx={{ color: tokenColors.number }}>
          {decorate(matchedText, tokenMatchOffset)}
        </Box>,
      );
    } else {
      const tokenMatchOffset = matchOffset + matchIndex;
      segments.push(
        <Box
          component="span"
          key={`json-token-${tokenIndex++}`}
          sx={{ color: tokenColors.punctuation }}
        >
          {decorate(matchedText, tokenMatchOffset)}
        </Box>,
      );
    }

    cursor = matchIndex + matchedText.length;
  }

  if (cursor < text.length) {
    segments.push(decorate(text.slice(cursor), matchOffset + cursor));
  }

  return segments.map((segment, index) => <Fragment key={index}>{segment}</Fragment>);
}

export function renderHighlightedText(
  text: string,
  searchQuery?: string,
  matcher?: SearchMatcher | null | undefined,
  currentMatchRange?: { start: number; end: number } | null | undefined,
  matchOffset = 0,
  matches?: Array<{ start: number; end: number }> | undefined,
  highlightRange?: TextRange | null | undefined,
) {
  if (matcher) {
    const absoluteMatches =
      matches ??
      matcher(text).map((match) => ({
        start: matchOffset + match.start,
        end: matchOffset + match.end,
      }));

    return renderHighlightedTextWithAbsoluteMatches(
      text,
      absoluteMatches,
      currentMatchRange,
      matchOffset,
      highlightRange,
    );
  }

  const normalizedQuery = normalizeSearch(searchQuery);
  const absoluteMatches = normalizedQuery
    ? collectQueryMatches(text, normalizedQuery, matchOffset)
    : [];

  if (absoluteMatches.length === 0) {
    return renderDecoratedText(text, matchOffset, [], highlightRange);
  }

  return renderDecoratedText(
    text,
    matchOffset,
    absoluteMatches,
    highlightRange,
    (chunk, _match, key) => (
      <Box component="mark" key={key} sx={{ bgcolor: "warning.light", px: 0.25 }}>
        {chunk}
      </Box>
    ),
  );
}

/**
 * Collect the absolute ranges of the literal query matches. Used as the
 * fallback decoration when a caller passes a search query without a matcher.
 */
function collectQueryMatches(
  text: string,
  normalizedQuery: string,
  matchOffset: number,
): TextRange[] {
  const matches: TextRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = findNormalizedMatchIndex(text, normalizedQuery, cursor);

    if (matchIndex === -1) {
      break;
    }

    const endIndex = matchIndex + normalizedQuery.length;
    matches.push({ start: matchOffset + matchIndex, end: matchOffset + endIndex });
    cursor = endIndex;
  }

  return matches;
}

function renderHighlightedTextWithAbsoluteMatches(
  text: string,
  absoluteMatches: Array<{ start: number; end: number }>,
  currentMatchRange: { start: number; end: number } | null | undefined,
  matchOffset: number,
  highlightRange?: TextRange | null | undefined,
) {
  return renderDecoratedText(
    text,
    matchOffset,
    absoluteMatches,
    highlightRange,
    (chunk, match, key) => {
      const isCurrent =
        currentMatchRange &&
        currentMatchRange.start === match.start &&
        currentMatchRange.end === match.end;

      return (
        <Box
          component="mark"
          data-match-index={match.start}
          key={key}
          sx={{
            bgcolor: isCurrent ? "warning.dark" : "warning.light",
            color: isCurrent ? "warning.contrastText" : undefined,
            px: 0.25,
          }}
        >
          {chunk}
        </Box>
      );
    },
  );
}

/**
 * Paint the selection highlight the context menu owns with the very colour the
 * platform uses for `::selection`, so the range the block draws itself looks
 * exactly like the platform selection it replaces.
 */
const menuHighlightSx: SxProps<Theme> = {
  backgroundColor: (theme: Theme) => getSelectionHighlightColor(theme.palette.mode),
};

type TextMatchRenderer = (
  chunk: string,
  match: { start: number; end: number },
  key: string,
) => React.ReactNode;

/**
 * Split `text` on every search match and on the highlight range, then hand each
 * chunk to `renderMatch`. `matchOffset` is the absolute body offset of
 * `text[0]`; the matches and `highlightRange` use those same absolute offsets,
 * so a highlight spanning several tokens still paints one continuous colour.
 */
function renderDecoratedText(
  text: string,
  matchOffset: number,
  matches: Array<{ start: number; end: number }>,
  highlightRange?: TextRange | null | undefined,
  renderMatch?: TextMatchRenderer,
): React.ReactNode {
  const segmentStart = matchOffset;
  const segmentEnd = matchOffset + text.length;
  const localHighlight = getLocalHighlightRange(highlightRange, matchOffset, text.length);
  const localMatches = matches
    .filter((match) => match.start < segmentEnd && match.end > segmentStart)
    .map((match) => ({
      end: Math.min(match.end, segmentEnd) - segmentStart,
      match,
      start: Math.max(match.start, segmentStart) - segmentStart,
    }));

  if (!localHighlight && localMatches.length === 0) {
    return text;
  }

  const cuts = new Set<number>([0, text.length]);

  for (const localMatch of localMatches) {
    cuts.add(localMatch.start);
    cuts.add(localMatch.end);
  }

  if (localHighlight) {
    cuts.add(localHighlight.start);
    cuts.add(localHighlight.end);
  }

  const boundaries = [...cuts].sort((left, right) => left - right);
  const segments: React.ReactNode[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? 0;

    if (end <= start) {
      continue;
    }

    const chunk = text.slice(start, end);
    const localMatch = localMatches.find(
      (candidate) => candidate.start <= start && candidate.end >= end,
    );
    let node: React.ReactNode =
      localMatch && renderMatch
        ? renderMatch(chunk, localMatch.match, `${localMatch.match.start}-${start}-${end}`)
        : chunk;

    if (localHighlight && start >= localHighlight.start && end <= localHighlight.end) {
      node = (
        <Box
          component="span"
          data-selection-highlight="true"
          key={`highlight-${start}-${end}`}
          sx={menuHighlightSx}
        >
          {node}
        </Box>
      );
    }

    segments.push(<Fragment key={`${start}-${end}`}>{node}</Fragment>);
  }

  return segments;
}

/** Intersect the absolute highlight with a segment, in segment-local offsets. */
function getLocalHighlightRange(
  highlightRange: TextRange | null | undefined,
  matchOffset: number,
  textLength: number,
): TextRange | null {
  if (!highlightRange) {
    return null;
  }

  const start = Math.max(highlightRange.start - matchOffset, 0);
  const end = Math.min(highlightRange.end - matchOffset, textLength);

  return end > start ? { start, end } : null;
}
