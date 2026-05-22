import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import { Box, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Snackbar, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { useCallback, type MouseEvent as ReactMouseEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/i18n";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "./context-menu.styles";
import {
  findNormalizedMatchIndex,
  formatJsonText,
  formatJsonPrimitive,
  isJsonObject,
  normalizeSearch,
  type JsonValue,
  type SearchMatcher,
} from "./session-inspector.helpers";
import {
  InspectorFlatTable,
  getWorkbenchFontSize,
  renderHighlightedText,
  useVirtualWindow,
} from "./SessionInspectorShared";

const JSON_TREE_ROW_HEIGHT = 20;
const JSON_TREE_FONT_SIZE = 12.5;

type JsonTreeRow = {
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  name?: string;
  path: string;
  value: JsonValue;
};

type JsonTreeContextMenuState = {
  anchorPosition: { left: number; top: number };
  row: JsonTreeRow;
};

function rowMatchesTexts(matcher: SearchMatcher, texts: (string | undefined)[]): boolean {
  return texts.some((text) => text !== undefined && text.length > 0 && matcher(text).length > 0);
}

export function SessionInspectorJsonTree({
  currentMatchIndex,
  matcher,
  onMatchCountChange,
  searchQuery,
  value,
}: {
  currentMatchIndex?: number | undefined;
  matcher?: SearchMatcher | null | undefined;
  onMatchCountChange?: ((count: number) => void) | undefined;
  searchQuery: string;
  value: JsonValue;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["root"]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contextMenuState, setContextMenuState] = useState<JsonTreeContextMenuState | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const menuItemSx = getContextMenuItemSx(theme);
  const iconSx = getContextMenuIconSx(theme);

  useEffect(() => {
    setExpandedPaths(new Set(["root"]));
    setSelectedPath(null);
    setContextMenuState(null);
    setSnackbarOpen(false);
  }, [value]);

  const handleContextMenuOpen = useCallback((row: JsonTreeRow, event: ReactMouseEvent) => {
    event.preventDefault();
    setSelectedPath(row.path);
    setContextMenuState({
      anchorPosition: { left: event.clientX - 2, top: event.clientY - 4 },
      row,
    });
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuState(null);
  }, []);

  const handleCopyNode = useCallback(async () => {
    if (!contextMenuState || !navigator.clipboard?.writeText) {
      return;
    }

    await navigator.clipboard.writeText(serializeJsonNode(contextMenuState.row.value));
    setSnackbarOpen(true);
    setContextMenuState(null);
  }, [contextMenuState]);

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);

      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }

      return nextPaths;
    });
  }, []);

  const autoExpandedPaths = useMemo(() => {
    const normalizedQuery = normalizeSearch(deferredSearchQuery);

    if (!normalizedQuery || normalizedQuery.length < 2) {
      return new Set<string>(["root"]);
    }

    const paths = new Set<string>(["root"]);
    collectMatchingExpansionPaths(value, normalizedQuery, "root", undefined, paths);
    return paths;
  }, [deferredSearchQuery, value]);

  const effectiveExpandedPaths = useMemo(() => {
    if (!matcher) return autoExpandedPaths;
    const paths = new Set(autoExpandedPaths);
    collectMatcherExpansionPaths(value, matcher, "root", undefined, paths);
    return paths;
  }, [autoExpandedPaths, matcher, value]);

  const rows = useMemo(
    () => buildVisibleJsonRows(value, expandedPaths, effectiveExpandedPaths),
    [effectiveExpandedPaths, expandedPaths, value],
  );

  const matchingRowPaths = useMemo(() => {
    if (!matcher) return [];
    const paths: string[] = [];
    for (const row of rows) {
      const displayName = row.name ?? t("inspector.json.root");
      const rowType = getJsonDisplayType(row.value, t);
      const rowValue = row.hasChildren ? "" : formatJsonPrimitive(row.value);
      if (rowMatchesTexts(matcher, [displayName, rowType, rowValue])) {
        paths.push(row.path);
      }
    }
    return paths;
  }, [matcher, rows, t]);

  useEffect(() => {
    if (onMatchCountChange) {
      onMatchCountChange(matchingRowPaths.length);
    }
  }, [matchingRowPaths.length, matcher, onMatchCountChange]);

  const { containerRef, endIndex, offsetTop, startIndex, totalHeight } = useVirtualWindow(rows.length, JSON_TREE_ROW_HEIGHT);

  useEffect(() => {
    if (!matcher || matchingRowPaths.length === 0 || currentMatchIndex === undefined) return;
    const targetPath = matchingRowPaths[currentMatchIndex];
    const targetRowIndex = targetPath ? rows.findIndex((row) => row.path === targetPath) : -1;

    if (targetPath) {
      setSelectedPath(targetPath);
    }

    const container = containerRef.current;
    if (!container || targetRowIndex === -1) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const centeredScrollTop = Math.max(
        0,
        targetRowIndex * JSON_TREE_ROW_HEIGHT - Math.max(0, container.clientHeight - JSON_TREE_ROW_HEIGHT) / 2,
      );

      container.scrollTop = centeredScrollTop;
      container.dispatchEvent(new Event("scroll"));
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [containerRef, currentMatchIndex, matcher, matchingRowPaths, rows]);

  const visibleRows = rows.slice(startIndex, endIndex);
  const columnTemplate = "minmax(340px, 1fr) minmax(300px, 0.9fr) minmax(360px, 1.2fr)";

  return (
    <Box
      ref={containerRef}
      sx={{
        bgcolor: "transparent",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        px: 1.25,
        py: 0.5,
      }}
    >
      <Box sx={{ height: totalHeight, minWidth: "100%", position: "relative", width: "max-content" }}>
        <Box sx={{ left: 0, position: "absolute", right: 0, top: offsetTop }}>
          <InspectorFlatTable columnTemplate={columnTemplate}>
            {visibleRows.map((row) => (
              <JsonTreeRowView
                columnTemplate={columnTemplate}
                key={row.path}
                matcher={matcher}
                onContextMenuOpen={handleContextMenuOpen}
                onSelectPath={setSelectedPath}
                onTogglePath={togglePath}
                row={row}
                searchQuery={deferredSearchQuery}
                selectedPath={selectedPath}
              />
            ))}
          </InspectorFlatTable>
        </Box>
      </Box>

      <Menu
        anchorPosition={contextMenuState?.anchorPosition ?? { left: 0, top: 0 }}
        anchorReference="anchorPosition"
        onClose={handleContextMenuClose}
        open={contextMenuState !== null}
        slotProps={buildContextMenuSlotProps(164)}
      >
        <MenuItem
          onClick={() => {
            void handleCopyNode();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <ContentCopyRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("inspector.json.copyNode")}</ListItemText>
        </MenuItem>
      </Menu>

      <Snackbar
        autoHideDuration={1800}
        message={t("contextMenu.copiedToClipboard")}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Box>
  );
}

function buildVisibleJsonRows(
  value: JsonValue,
  expandedPaths: Set<string>,
  autoExpandedPaths: Set<string>,
) {
  const rows: JsonTreeRow[] = [];
  const rootChildren = getJsonChildren(value);

  if (rootChildren.length === 0) {
    appendVisibleJsonRows(rows, value, "root", 0, expandedPaths, autoExpandedPaths, "root");
    return rows;
  }

  rootChildren.forEach(([childName, childValue]) => {
    appendVisibleJsonRows(rows, childValue, `root.${childName}`, 0, expandedPaths, autoExpandedPaths, childName);
  });

  return rows;
}

function appendVisibleJsonRows(
  rows: JsonTreeRow[],
  value: JsonValue,
  path: string,
  depth: number,
  expandedPaths: Set<string>,
  autoExpandedPaths: Set<string>,
  name?: string,
) {
  const children = getJsonChildren(value);
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren && (expandedPaths.has(path) || autoExpandedPaths.has(path));

  rows.push({
    depth,
    hasChildren,
    isExpanded,
    path,
    value,
    ...(name !== undefined ? { name } : {}),
  });

  if (!isExpanded) {
    return;
  }

  children.forEach(([childName, childValue]) => {
    appendVisibleJsonRows(
      rows,
      childValue,
      `${path}.${childName}`,
      depth + 1,
      expandedPaths,
      autoExpandedPaths,
      childName,
    );
  });
}

function getJsonChildren(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [`[${index}]`, entry] as [string, JsonValue]);
  }

  if (isJsonObject(value)) {
    return Object.entries(value);
  }

  return [];
}

function getJsonDisplayType(value: JsonValue, t: ReturnType<typeof useI18n>["t"]): string {
  if (Array.isArray(value)) {
    return t("inspector.json.array", { count: value.length });
  }

  if (isJsonObject(value)) {
    return t("inspector.json.object", { count: Object.keys(value).length });
  }

  if (value === null) {
    return t("inspector.json.null");
  }

  if (typeof value === "string") {
    return t("inspector.json.string");
  }

  if (typeof value === "number") {
    return t("inspector.json.number");
  }

  if (typeof value === "boolean") {
    return t("inspector.json.boolean");
  }

  return t("inspector.json.unknown");
}

function serializeJsonNode(value: JsonValue) {
  if (Array.isArray(value) || isJsonObject(value)) {
    return formatJsonText(value);
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function collectMatchingExpansionPaths(
  value: JsonValue,
  searchQuery: string,
  path: string,
  name: string | undefined,
  expandedPaths: Set<string>,
): boolean {
  const selfMatches =
    ((name ? findNormalizedMatchIndex(name, searchQuery) !== -1 : false)) ||
    (typeof value === "string"
      ? findNormalizedMatchIndex(value, searchQuery) !== -1
      : typeof value === "number" || typeof value === "boolean" || value === null
        ? findNormalizedMatchIndex(String(value), searchQuery) !== -1
        : false);

  if (Array.isArray(value)) {
    let hasMatchingDescendant = false;

    value.forEach((childValue, index) => {
      const childName = `[${index}]`;
      const childPath = `${path}.${childName}`;
      if (collectMatchingExpansionPaths(childValue, searchQuery, childPath, childName, expandedPaths)) {
        hasMatchingDescendant = true;
      }
    });

    if (hasMatchingDescendant) {
      expandedPaths.add(path);
    }

    return selfMatches || hasMatchingDescendant;
  }

  if (isJsonObject(value)) {
    let hasMatchingDescendant = false;

    Object.entries(value).forEach(([childName, childValue]) => {
      const childPath = `${path}.${childName}`;
      if (collectMatchingExpansionPaths(childValue, searchQuery, childPath, childName, expandedPaths)) {
        hasMatchingDescendant = true;
      }
    });

    if (hasMatchingDescendant) {
      expandedPaths.add(path);
    }

    return selfMatches || hasMatchingDescendant;
  }

  return selfMatches;
}

function collectMatcherExpansionPaths(
  value: JsonValue,
  matcher: SearchMatcher,
  path: string,
  name: string | undefined,
  expandedPaths: Set<string>,
): boolean {
  const selfMatches = rowMatchesTexts(matcher, [
    name,
    typeof value === "string" ? value : undefined,
    typeof value === "number" || typeof value === "boolean" || value === null ? String(value) : undefined,
  ]);

  if (Array.isArray(value)) {
    let hasMatchingDescendant = false;

    value.forEach((childValue, index) => {
      const childName = `[${index}]`;
      const childPath = `${path}.${childName}`;
      if (collectMatcherExpansionPaths(childValue, matcher, childPath, childName, expandedPaths)) {
        hasMatchingDescendant = true;
      }
    });

    if (hasMatchingDescendant) {
      expandedPaths.add(path);
    }

    return selfMatches || hasMatchingDescendant;
  }

  if (isJsonObject(value)) {
    let hasMatchingDescendant = false;

    Object.entries(value).forEach(([childName, childValue]) => {
      const childPath = `${path}.${childName}`;
      if (collectMatcherExpansionPaths(childValue, matcher, childPath, childName, expandedPaths)) {
        hasMatchingDescendant = true;
      }
    });

    if (hasMatchingDescendant) {
      expandedPaths.add(path);
    }

    return selfMatches || hasMatchingDescendant;
  }

  return selfMatches;
}

function getJsonTypeTone(theme: Theme) {
  return {
    color: theme.palette.mode === "dark" ? theme.palette.text.secondary : "#111111",
  };
}

function JsonTreeRowView({
  columnTemplate,
  matcher,
  onContextMenuOpen,
  onSelectPath,
  onTogglePath,
  row,
  searchQuery,
  selectedPath,
}: {
  columnTemplate: string;
  matcher?: SearchMatcher | null | undefined;
  onContextMenuOpen: (row: JsonTreeRow, event: ReactMouseEvent) => void;
  onSelectPath: (path: string) => void;
  onTogglePath: (path: string) => void;
  row: JsonTreeRow;
  searchQuery: string;
  selectedPath: string | null;
}) {
  const { t } = useI18n();
  const { depth, hasChildren, isExpanded, name, path, value } = row;
  const theme = useTheme();
  const rowValue = hasChildren ? "" : formatJsonPrimitive(value);
  const rowType = getJsonDisplayType(value, t);
  const displayName = name ?? t("inspector.json.root");
  const isSelected = selectedPath === path;
  const selectedRowBackground = theme.palette.mode === "dark" ? "#0A64C9" : "#0069D9";
  const selectedRowHoverBackground = theme.palette.mode === "dark" ? "#0B72E3" : "#0069D9";
  const hoverBackground = theme.palette.mode === "dark" ? alpha("#FFFFFF", 0.06) : alpha("#000000", 0.035);
  const dividerColor = theme.palette.mode === "dark" ? alpha("#FFFFFF", 0.14) : "#E6E9EE";
  const bodyTextColor = theme.palette.mode === "dark" ? theme.palette.text.primary : "#111111";
  const selectedTextColor = "#FFFFFF";
  const valueColor = isSelected ? selectedTextColor : bodyTextColor;
  const typeTone = getJsonTypeTone(theme);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const [isValueOverflowing, setIsValueOverflowing] = useState(false);

  useEffect(() => {
    const element = valueRef.current;
    if (!element) return undefined;

    const updateOverflow = () => {
      setIsValueOverflowing(element.scrollWidth > element.clientWidth);
    };

    updateOverflow();

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(updateOverflow);
      resizeObserver.observe(element);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener("resize", updateOverflow);
    return () => window.removeEventListener("resize", updateOverflow);
  }, [rowValue]);

  function highlight(text: string) {
    if (matcher) {
      return renderHighlightedText(text, undefined, matcher);
    }
    return renderHighlightedText(text, searchQuery);
  }

  return (
    <Box
      sx={{
        backgroundColor: isSelected ? selectedRowBackground : "transparent",
        borderRadius: isSelected ? 0.75 : 0,
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: columnTemplate,
        minHeight: JSON_TREE_ROW_HEIGHT,
        transition: "background-color 80ms ease",
        "&:hover": {
          backgroundColor: isSelected ? selectedRowHoverBackground : hoverBackground,
        },
      }}
      onClick={() => onSelectPath(path)}
      onContextMenu={(event) => onContextMenuOpen(row, event)}
    >
      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          minWidth: 0,
          pl: depth * 1.9 + 1.2,
          pr: 0.75,
        }}
      >
        {hasChildren ? (
          <IconButton
            onClick={(event) => {
              event.stopPropagation();
              onTogglePath(path);
            }}
            size="small"
            sx={{
              color: isSelected ? selectedTextColor : alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.78 : 0.45),
              mr: 0.15,
              p: 0,
              width: 14,
              "& .MuiSvgIcon-root": {
                fontSize: 16,
              },
            }}
          >
            {isExpanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
          </IconButton>
        ) : (
          <Box sx={{ flex: "0 0 14px", mr: 0.15 }} />
        )}

        <Box
          sx={{
            alignItems: "center",
            color: isSelected
              ? selectedTextColor
              : hasChildren
                ? theme.palette.mode === "dark" ? "#6FD6F4" : "#5CC8E6"
                : theme.palette.mode === "dark" ? "#AAB4C3" : "#C8D0DA",
            display: "flex",
            flex: "0 0 auto",
            mr: 0.55,
          }}
        >
          {hasChildren ? <FolderRoundedIcon sx={{ fontSize: 17 }} /> : <DescriptionOutlinedIcon sx={{ fontSize: 15.5 }} />}
        </Box>

        <Typography
          sx={{
            color: isSelected ? selectedTextColor : bodyTextColor,
            fontSize: getWorkbenchFontSize(theme, JSON_TREE_FONT_SIZE),
            fontWeight: hasChildren ? 500 : 400,
            lineHeight: `${JSON_TREE_ROW_HEIGHT}px`,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {highlight(displayName)}
        </Typography>
      </Box>

      <Box
        sx={{
          alignItems: "center",
          borderLeft: `1px solid ${dividerColor}`,
          display: "flex",
          minWidth: 0,
          px: 0.625,
        }}
      >
        <Typography
          sx={{
            color: isSelected ? selectedTextColor : typeTone.color,
            fontSize: getWorkbenchFontSize(theme, JSON_TREE_FONT_SIZE),
            fontWeight: 400,
            lineHeight: `${JSON_TREE_ROW_HEIGHT}px`,
            maxWidth: "100%",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          variant="body2"
        >
          {highlight(rowType)}
        </Typography>
      </Box>

      <Box
        sx={{
          alignItems: "center",
          borderLeft: `1px solid ${dividerColor}`,
          color: valueColor,
          display: "flex",
          minWidth: 0,
          px: 0.75,
        }}
      >
        {rowValue ? (
          <Tooltip arrow placement="top-start" title={isValueOverflowing ? rowValue : ""}>
            <Typography
              ref={valueRef}
              sx={{
                color: valueColor,
                fontSize: getWorkbenchFontSize(theme, JSON_TREE_FONT_SIZE),
                fontWeight: 400,
                lineHeight: `${JSON_TREE_ROW_HEIGHT}px`,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              variant="body2"
            >
              {highlight(rowValue)}
            </Typography>
          </Tooltip>
        ) : null}
      </Box>
    </Box>
  );
}
