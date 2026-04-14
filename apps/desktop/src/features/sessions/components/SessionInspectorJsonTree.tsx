import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { Fragment, useEffect, useMemo, useState } from "react";

import { getSyntaxColors } from "@/themes/app-theme";
import {
  formatJsonPrimitive,
  isJsonObject,
  normalizeSearch,
  type JsonValue,
} from "./session-inspector.helpers";
import { InspectorFlatTable, renderHighlightedText } from "./SessionInspectorShared";

export function SessionInspectorJsonTree({
  searchQuery,
  value,
}: {
  searchQuery: string;
  value: JsonValue;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["root"]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

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
    const normalizedQuery = normalizeSearch(searchQuery);

    if (!normalizedQuery) {
      return new Set<string>(["root"]);
    }

    const paths = new Set<string>(["root"]);
    collectMatchingExpansionPaths(value, normalizedQuery, "root", undefined, paths);
    return paths;
  }, [searchQuery, value]);

  const columnTemplate = "minmax(210px, 1.7fr) minmax(88px, 0.62fr) minmax(140px, 1.18fr)";
  const rootChildren = getJsonChildren(value);

  return (
    <InspectorFlatTable columnTemplate={columnTemplate}>
      {rootChildren.length > 0
        ? rootChildren.map(([childName, childValue]) => {
            const childPath = `root.${childName}`;

            return (
              <JsonTreeNode
                autoExpandedPaths={autoExpandedPaths}
                columnTemplate={columnTemplate}
                depth={0}
                expandedPaths={expandedPaths}
                key={childPath}
                name={childName}
                onSelectPath={setSelectedPath}
                onTogglePath={togglePath}
                path={childPath}
                searchQuery={searchQuery}
                selectedPath={selectedPath}
                value={childValue}
              />
            );
          })
        : (
          <JsonTreeNode
            autoExpandedPaths={autoExpandedPaths}
            columnTemplate={columnTemplate}
            depth={0}
            expandedPaths={expandedPaths}
            name="root"
            onSelectPath={setSelectedPath}
            onTogglePath={togglePath}
            path="root"
            searchQuery={searchQuery}
            selectedPath={selectedPath}
            value={value}
          />
        )}
    </InspectorFlatTable>
  );
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
    (name?.includes(searchQuery) ?? false) ||
    (typeof value === "string"
      ? value.includes(searchQuery)
      : typeof value === "number" || typeof value === "boolean" || value === null
        ? String(value).includes(searchQuery)
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

function JsonTreeNode({
  autoExpandedPaths,
  columnTemplate,
  depth,
  expandedPaths,
  name,
  onSelectPath,
  onTogglePath,
  path,
  searchQuery,
  selectedPath,
  value,
}: {
  autoExpandedPaths: Set<string>;
  columnTemplate: string;
  depth: number;
  expandedPaths: Set<string>;
  name?: string;
  onSelectPath: (path: string) => void;
  onTogglePath: (path: string) => void;
  path: string;
  searchQuery: string;
  selectedPath: string | null;
  value: JsonValue;
}) {
  const children = getJsonChildren(value);
  const hasChildren = children.length > 0;
  const theme = useTheme();
  const syntaxColors = getSyntaxColors(theme.palette.mode);

  const isExpanded = expandedPaths.has(path) || autoExpandedPaths.has(path);
  const rowValue = hasChildren ? "" : formatJsonPrimitive(value);
  const rowType = getJsonDisplayType(value);
  const displayName = name ?? "root";
  const isExpandedParent = hasChildren && isExpanded;
  const isSelected = selectedPath === path;
  const highlightedRowBackground = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.1);
  const highlightedRowBorder = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.42 : 0.3);
  const selectedRowBackground = theme.palette.primary.main;
  const typeColor = "text.secondary";
  const valueColor =
    typeof value === "string"
      ? syntaxColors.string
      : typeof value === "number"
        ? syntaxColors.number
        : typeof value === "boolean" || value === null
          ? syntaxColors.boolean
          : "text.primary";

  return (
    <Fragment>
      <Box
        sx={{
          backgroundColor: isSelected ? selectedRowBackground : isExpandedParent ? highlightedRowBackground : "transparent",
          borderLeft: `2px solid ${isSelected || isExpandedParent ? highlightedRowBorder : "transparent"}`,
          borderRadius: 1,
          cursor: "pointer",
          display: "grid",
          gridTemplateColumns: columnTemplate,
          minHeight: 26,
          transition: "background-color 120ms ease, border-color 120ms ease",
          "&:hover": {
            backgroundColor: isSelected ? selectedRowBackground : isExpandedParent ? highlightedRowBackground : "action.hover",
          },
        }}
        onClick={() => onSelectPath(path)}
      >
        <Box
          sx={{
            alignItems: "center",
            display: "flex",
            minWidth: 0,
            pl: depth * 2 + 0.25,
            pr: 0.75,
            py: 0.375,
          }}
        >
          {hasChildren ? (
            <IconButton
              onClick={() => onTogglePath(path)}
              size="small"
              sx={{
                color: isSelected ? "common.white" : isExpandedParent ? "primary.main" : "text.secondary",
                mr: 0.125,
                p: 0,
                "& .MuiSvgIcon-root": {
                  fontSize: 16,
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
              color: isSelected ? "common.white" : isExpandedParent ? "primary.main" : hasChildren ? "info.main" : "text.secondary",
              display: "flex",
              flex: "0 0 auto",
              mr: 0.75,
            }}
          >
            {hasChildren ? (
              isExpanded ? <FolderOpenRoundedIcon sx={{ fontSize: 18 }} /> : <FolderRoundedIcon sx={{ fontSize: 18 }} />
            ) : (
              <DescriptionOutlinedIcon sx={{ fontSize: 17 }} />
            )}
          </Box>

          <Typography
            sx={{
              color: isSelected ? "common.white" : "text.primary",
              fontSize: 14,
              fontWeight: isSelected || isExpandedParent ? 600 : 400,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {renderHighlightedText(displayName, searchQuery)}
          </Typography>
        </Box>

        <Box
          sx={{
            alignItems: "center",
            borderLeft: `1px solid ${isSelected ? alpha(theme.palette.common.white, 0.26) : theme.palette.divider}`,
            display: "flex",
            minWidth: 0,
            px: 0.875,
            py: 0.375,
          }}
        >
          <Typography sx={{ color: isSelected ? alpha(theme.palette.common.white, 0.9) : typeColor, fontSize: 14, minWidth: 0 }} variant="body2">
            {renderHighlightedText(rowType, searchQuery)}
          </Typography>
        </Box>

        <Box
          sx={{
            alignItems: "center",
            borderLeft: `1px solid ${isSelected ? alpha(theme.palette.common.white, 0.26) : theme.palette.divider}`,
            color: isSelected ? "common.white" : valueColor,
            display: "flex",
            minWidth: 0,
            px: 0.875,
            py: 0.375,
          }}
        >
          {rowValue ? (
            <Tooltip arrow placement="top-start" title={rowValue}>
              <Typography
                sx={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                variant="body2"
              >
                {renderHighlightedText(rowValue, searchQuery)}
              </Typography>
            </Tooltip>
          ) : null}
        </Box>
      </Box>

      {hasChildren && isExpanded
        ? children.map(([childName, childValue]) => {
            const childPath = `${path}.${childName}`;

            return (
              <JsonTreeNode
                autoExpandedPaths={autoExpandedPaths}
                columnTemplate={columnTemplate}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                key={childPath}
                name={childName}
                onSelectPath={onSelectPath}
                onTogglePath={onTogglePath}
                path={childPath}
                searchQuery={searchQuery}
                selectedPath={selectedPath}
                value={childValue}
              />
            );
          })
        : null}
    </Fragment>
  );
}
