import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { getSyntaxColors } from "@/themes/app-theme";
import {
  findNormalizedMatchIndex,
  formatJsonPrimitive,
  isJsonObject,
  normalizeSearch,
  type JsonValue,
  type SearchMatcher,
} from "./session-inspector.helpers";
import { InspectorFlatTable, renderHighlightedText, useVirtualWindow } from "./SessionInspectorShared";

const JSON_TREE_ROW_HEIGHT = 32;

type JsonTreeRow = {
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  name?: string;
  path: string;
  value: JsonValue;
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["root"]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    setExpandedPaths(new Set(["root"]));
    setSelectedPath(null);
  }, [value]);

  function togglePath(path: string) {
    setExpandedPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);

      if (nextPaths.has(path)) {
        nextPaths.delete(path);
      } else {
        nextPaths.add(path);
      }

      return nextPaths;
    });
  }

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
      const displayName = row.name ?? "root";
      const rowType = getJsonDisplayType(row.value);
      const rowValue = row.hasChildren ? "" : formatJsonPrimitive(row.value);
      if (rowMatchesTexts(matcher, [displayName, rowType, rowValue])) {
        paths.push(row.path);
      }
    }
    return paths;
  }, [matcher, rows]);

  useEffect(() => {
    if (onMatchCountChange) {
      onMatchCountChange(matchingRowPaths.length);
    }
  }, [matchingRowPaths.length, matcher, onMatchCountChange]);

  useEffect(() => {
    if (!matcher || matchingRowPaths.length === 0 || currentMatchIndex === undefined) return;
    const targetPath = matchingRowPaths[currentMatchIndex];
    if (targetPath) {
      setSelectedPath(targetPath);
    }
  }, [currentMatchIndex, matcher, matchingRowPaths]);

  const { containerRef, endIndex, offsetTop, startIndex, totalHeight } = useVirtualWindow(rows.length, JSON_TREE_ROW_HEIGHT);
  const visibleRows = rows.slice(startIndex, endIndex);
  const columnTemplate = "minmax(220px, 1.02fr) minmax(112px, 0.68fr) minmax(260px, 1.3fr)";

  return (
    <Box
      ref={containerRef}
      sx={{
        bgcolor: "background.paper",
        flex: 1,
        minHeight: 0,
        overflow: "auto",
      }}
    >
      <Box sx={{ height: totalHeight, minWidth: "100%", position: "relative" }}>
        <Box sx={{ left: 0, position: "absolute", right: 0, top: offsetTop }}>
          <InspectorFlatTable columnTemplate={columnTemplate}>
            {visibleRows.map((row) => (
              <JsonTreeRowView
                columnTemplate={columnTemplate}
                key={row.path}
                matcher={matcher}
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

function getJsonDisplayType(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `Array[${value.length}]`;
  }

  if (isJsonObject(value)) {
    return `Object[${Object.keys(value).length}]`;
  }

  if (value === null) {
    return "Null";
  }

  if (typeof value === "string") {
    return "String";
  }

  if (typeof value === "number") {
    return "Number";
  }

  if (typeof value === "boolean") {
    return "Boolean";
  }

  return "Unknown";
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

function JsonTreeRowView({
  columnTemplate,
  matcher,
  onSelectPath,
  onTogglePath,
  row,
  searchQuery,
  selectedPath,
}: {
  columnTemplate: string;
  matcher?: SearchMatcher | null | undefined;
  onSelectPath: (path: string) => void;
  onTogglePath: (path: string) => void;
  row: JsonTreeRow;
  searchQuery: string;
  selectedPath: string | null;
}) {
  const { depth, hasChildren, isExpanded, name, path, value } = row;
  const theme = useTheme();
  const syntaxColors = getSyntaxColors(theme.palette.mode);
  const rowValue = hasChildren ? "" : formatJsonPrimitive(value);
  const rowType = getJsonDisplayType(value);
  const displayName = name ?? "root";
  const isSelected = selectedPath === path;
  const selectedRowBackground = theme.palette.primary.main;
  const dividerColor = isSelected ? alpha(theme.palette.common.white, 0.22) : theme.palette.divider;
  const textColor = isSelected ? "common.white" : "text.primary";
  const valueColor = isSelected
    ? "common.white"
    : typeof value === "string"
      ? syntaxColors.string
      : typeof value === "number"
        ? syntaxColors.number
        : typeof value === "boolean" || value === null
          ? syntaxColors.boolean
          : "text.primary";

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
          backgroundColor: isSelected ? selectedRowBackground : "action.hover",
        },
      }}
      onClick={() => onSelectPath(path)}
    >
      <Box
        sx={{
          alignItems: "center",
          display: "flex",
          minWidth: 0,
          pl: depth * 1.5 + 0.5,
          pr: 0.75,
          py: 0.25,
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
              color: isSelected ? "common.white" : "text.secondary",
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
            color: isSelected ? "common.white" : hasChildren ? "info.main" : "text.secondary",
            display: "flex",
            flex: "0 0 auto",
            mr: 0.625,
          }}
        >
          {hasChildren ? (
            isExpanded ? <FolderOpenRoundedIcon sx={{ fontSize: 17 }} /> : <FolderRoundedIcon sx={{ fontSize: 17 }} />
          ) : (
            <DescriptionOutlinedIcon sx={{ fontSize: 16 }} />
          )}
        </Box>

        <Typography
          sx={{
            color: textColor,
            fontSize: 13,
            fontWeight: 400,
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
          px: 0.875,
          py: 0.25,
        }}
      >
        <Typography sx={{ color: textColor, fontSize: 13, lineHeight: 1.35, minWidth: 0 }} variant="body2">
          {highlight(rowType)}
        </Typography>
      </Box>

      <Box
        sx={{
          alignItems: "center",
          borderLeft: `1px solid ${dividerColor}`,
          color: isSelected ? "common.white" : valueColor,
          display: "flex",
          minWidth: 0,
          px: 0.875,
          py: 0.25,
        }}
      >
        {rowValue ? (
          <Tooltip arrow placement="top-start" title={rowValue}>
            <Typography
              sx={{
                fontSize: 13,
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
