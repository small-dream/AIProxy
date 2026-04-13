import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, IconButton, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { Fragment, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/i18n";
import { getSyntaxColors } from "@/themes/app-theme";
import {
  formatJsonPrimitive,
  getJsonValueType,
  isJsonObject,
  normalizeSearch,
  type JsonValue,
} from "./session-inspector.helpers";
import { EllipsizedCell, InspectorFlatTable, InspectorFlatTableRow, renderHighlightedText } from "./SessionInspectorShared";

export function SessionInspectorJsonTree({
  searchQuery,
  value,
}: {
  searchQuery: string;
  value: JsonValue;
}) {
  const { t } = useI18n();
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["root"]));

  useEffect(() => {
    setExpandedPaths(new Set(["root"]));
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

  return (
    <InspectorFlatTable columnTemplate={columnTemplate}>
      <JsonTreeNode
        columnTemplate={columnTemplate}
        depth={0}
        autoExpandedPaths={autoExpandedPaths}
        expandedPaths={expandedPaths}
        onTogglePath={togglePath}
        path="root"
        searchQuery={searchQuery}
        rootLabel={t("inspector.json.root")}
        typeLabels={{
          array: (count) => t("inspector.json.array", { count }),
          boolean: t("inspector.json.boolean"),
          integer: t("inspector.json.integer"),
          null: t("inspector.json.null"),
          number: t("inspector.json.number"),
          object: (count) => t("inspector.json.object", { count }),
          string: t("inspector.json.string"),
          unknown: t("inspector.json.unknown"),
        }}
        value={value}
      />
    </InspectorFlatTable>
  );
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
  onTogglePath,
  path,
  rootLabel,
  searchQuery,
  typeLabels,
  value,
}: {
  autoExpandedPaths: Set<string>;
  columnTemplate: string;
  depth: number;
  expandedPaths: Set<string>;
  name?: string;
  onTogglePath: (path: string) => void;
  path: string;
  rootLabel: string;
  searchQuery: string;
  typeLabels: {
    array: (count: number) => string;
    boolean: string;
    integer: string;
    null: string;
    number: string;
    object: (count: number) => string;
    string: string;
    unknown: string;
  };
  value: JsonValue;
}) {
  const objectEntries = isJsonObject(value) ? Object.entries(value) : [];
  const arrayEntries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : [];
  const children = isJsonObject(value) ? objectEntries : arrayEntries;
  const hasChildren = children.length > 0;
  const theme = useTheme();
  const syntaxColors = getSyntaxColors(theme.palette.mode);

  const isExpanded = expandedPaths.has(path) || autoExpandedPaths.has(path);
  const rowValue = hasChildren ? "" : formatJsonPrimitive(value);
  const rowType = getJsonValueType(value, typeLabels);
  const displayName = path === "root" ? rootLabel : name ?? "";
  const nameColor = path === "root" ? "text.primary" : hasChildren ? syntaxColors.property : theme.palette.primary.main;
  const typeColor = hasChildren ? "text.secondary" : syntaxColors.type;
  const valueColor =
    typeof value === "string"
      ? syntaxColors.value
      : typeof value === "number"
        ? syntaxColors.number
        : typeof value === "boolean" || value === null
          ? syntaxColors.boolean
          : "text.primary";

  return (
    <Fragment>
      <InspectorFlatTableRow
        cells={[
          <Box
            key="name"
            sx={{
              alignItems: "center",
              display: "flex",
              minWidth: 0,
              pl: depth * 1.1,
            }}
          >
            {hasChildren ? (
              <IconButton
                onClick={() => onTogglePath(path)}
                size="small"
                sx={{
                  color: "text.secondary",
                  mr: 0.25,
                  p: 0,
                  "& .MuiSvgIcon-root": {
                    fontSize: 16,
                  },
                }}
              >
                {isExpanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
              </IconButton>
            ) : (
              <Box sx={{ flex: "0 0 16px", mr: 0.25 }} />
            )}
            <Typography
              sx={{
                color: nameColor,
                fontWeight: hasChildren && isExpanded ? 500 : 400,
                minWidth: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
              variant="body2"
            >
              {renderHighlightedText(displayName, searchQuery)}
            </Typography>
          </Box>,
          <Typography key="type" sx={{ color: typeColor, minWidth: 0 }} variant="caption">
            {renderHighlightedText(rowType, searchQuery)}
          </Typography>,
          <Box key="value" sx={{ color: valueColor, minWidth: 0, width: "100%" }}>
            {rowValue ? <EllipsizedCell text={rowValue} /> : ""}
          </Box>,
        ]}
        columnTemplate={columnTemplate}
        dense
        hoverable
      />

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
                onTogglePath={onTogglePath}
                path={childPath}
                rootLabel={rootLabel}
                searchQuery={searchQuery}
                typeLabels={typeLabels}
                value={childValue}
              />
            );
          })
        : null}
    </Fragment>
  );
}
