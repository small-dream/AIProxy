import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
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
import { InspectorFlatTable, renderHighlightedText, useVirtualWindow } from "./SessionInspectorShared";

const JSON_TREE_ROW_HEIGHT = 26;

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
  const columnTemplate = "minmax(240px, 0.95fr) minmax(96px, 0.28fr) minmax(320px, 1.85fr)";

  return (
    <Box
      ref={containerRef}
      sx={{
        bgcolor: "transparent",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        px: 0.5,
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
        slotProps={buildContextMenuSlotProps(188)}
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
    return value.map((entry, index) => [String(index), entry] as [string, JsonValue]);
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
      const childPath = `${path}.${index}`;
      if (collectMatchingExpansionPaths(childValue, searchQuery, childPath, String(index), expandedPaths)) {
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
      const childPath = `${path}.${index}`;
      if (collectMatcherExpansionPaths(childValue, matcher, childPath, String(index), expandedPaths)) {
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

function getJsonTypeTone(value: JsonValue, theme: Theme) {
  if (Array.isArray(value)) {
    return {
      color: alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.88 : 0.82),
    };
  }

  if (isJsonObject(value)) {
    return {
      color: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.88 : 0.82),
    };
  }

  if (typeof value === "string") {
    return {
      color: theme.palette.text.secondary,
    };
  }

  if (typeof value === "number") {
    return {
      color: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.9 : 0.82),
    };
  }

  if (typeof value === "boolean" || value === null) {
    return {
      color: theme.palette.text.secondary,
    };
  }

  return {
    color: theme.palette.text.secondary,
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
  const selectedRowBackground = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.07);
  const selectedRowHoverBackground = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.09);
  const dividerColor = alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.44 : 0.6);
  const textColor = "text.primary";
  const valueColor = typeof value === "string"
    ? theme.palette.text.primary
    : typeof value === "number"
      ? theme.palette.mode === "dark" ? "#EABF65" : "#8A5A00"
      : typeof value === "boolean" || value === null
        ? theme.palette.primary.main
        : "text.primary";
  const typeTone = getJsonTypeTone(value, theme);
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
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: columnTemplate,
        minHeight: JSON_TREE_ROW_HEIGHT,
        transition: "background-color 120ms ease",
        "&:hover": {
          backgroundColor: isSelected
            ? selectedRowHoverBackground
            : alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.045 : 0.028),
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
          pl: depth * 1.25 + 0.5,
          pr: 0.75,
          py: 0.125,
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
              color: isSelected ? "primary.main" : "text.secondary",
              mr: 0.25,
              p: 0,
              "& .MuiSvgIcon-root": {
                fontSize: 15,
              },
            }}
          >
            {isExpanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
          </IconButton>
        ) : (
          <Box sx={{ flex: "0 0 16px", mr: 0.125 }} />
        )}

        <Box
          sx={{
            alignItems: "center",
            color: isSelected
              ? "primary.main"
              : hasChildren
                ? alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.88 : 0.9)
                : alpha(theme.palette.text.secondary, theme.palette.mode === "dark" ? 0.8 : 0.72),
            display: "flex",
            flex: "0 0 auto",
            mr: 0.625,
            opacity: isSelected ? 1 : 0.96,
          }}
        >
          {hasChildren ? (
            isExpanded ? (
              <FolderOpenOutlinedIcon sx={{ fontSize: 18, strokeWidth: 1.4 }} />
            ) : (
              <FolderOutlinedIcon sx={{ fontSize: 18, strokeWidth: 1.4 }} />
            )
          ) : (
            <DescriptionOutlinedIcon sx={{ fontSize: 16.5, strokeWidth: 1.4 }} />
          )}
        </Box>

        <Typography
          sx={{
            color: textColor,
            fontSize: 12.5,
            fontWeight: hasChildren ? 650 : 500,
            lineHeight: 1.35,
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
          px: 0.75,
          py: 0.125,
        }}
      >
        <Typography
          sx={{
            color: typeTone.color,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.25,
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
          px: 0.875,
          py: 0.125,
        }}
      >
        {rowValue ? (
          <Tooltip arrow placement="top-start" title={isValueOverflowing ? rowValue : ""}>
            <Typography
              ref={valueRef}
              sx={{
                fontSize: 12.75,
                fontWeight: 500,
                lineHeight: 1.35,
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
