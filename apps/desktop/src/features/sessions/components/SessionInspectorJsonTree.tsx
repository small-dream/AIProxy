import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, IconButton, Typography } from "@mui/material";
import { Fragment, useEffect, useState } from "react";

import {
  formatJsonPrimitive,
  getJsonValueType,
  isJsonObject,
  jsonSubtreeMatches,
  type JsonValue,
} from "./session-inspector.helpers";
import { InspectorFlatTable, InspectorFlatTableRow, renderHighlightedText } from "./SessionInspectorShared";

export function SessionInspectorJsonTree({
  searchQuery,
  value,
}: {
  searchQuery: string;
  value: JsonValue;
}) {
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

  const columnTemplate = "minmax(210px, 1.7fr) minmax(88px, 0.62fr) minmax(140px, 1.18fr)";

  return (
    <InspectorFlatTable columnTemplate={columnTemplate} headers={["Name", "Type", "Value"]}>
      <JsonTreeNode
        columnTemplate={columnTemplate}
        depth={0}
        expandedPaths={expandedPaths}
        onTogglePath={togglePath}
        path="root"
        searchQuery={searchQuery}
        value={value}
      />
    </InspectorFlatTable>
  );
}

function JsonTreeNode({
  columnTemplate,
  depth,
  expandedPaths,
  name,
  onTogglePath,
  path,
  searchQuery,
  value,
}: {
  columnTemplate: string;
  depth: number;
  expandedPaths: Set<string>;
  name?: string;
  onTogglePath: (path: string) => void;
  path: string;
  searchQuery: string;
  value: JsonValue;
}) {
  const objectEntries = isJsonObject(value) ? Object.entries(value) : [];
  const arrayEntries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : [];
  const children = isJsonObject(value) ? objectEntries : arrayEntries;
  const hasChildren = children.length > 0;
  const subtreeMatches = !searchQuery || jsonSubtreeMatches(name, value, searchQuery);

  if (!subtreeMatches) {
    return null;
  }

  const autoExpanded = Boolean(searchQuery) && hasChildren;
  const isExpanded = expandedPaths.has(path) || autoExpanded;
  const rowValue = hasChildren ? "" : formatJsonPrimitive(value);
  const rowType = getJsonValueType(value);
  const displayName = path === "root" ? "root" : name ?? "";
  const nameColor = path === "root" ? "text.primary" : hasChildren ? "#795e26" : "#001080";
  const typeColor = hasChildren ? "text.secondary" : "#6f42c1";
  const valueColor =
    typeof value === "string"
      ? "#a31515"
      : typeof value === "number"
        ? "#098658"
        : typeof value === "boolean" || value === null
          ? "#0000ff"
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
          <Typography key="value" sx={{ color: valueColor, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }} variant="body2">
            {rowValue ? renderHighlightedText(rowValue, searchQuery) : ""}
          </Typography>,
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
                columnTemplate={columnTemplate}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                key={childPath}
                name={childName}
                onTogglePath={onTogglePath}
                path={childPath}
                searchQuery={searchQuery}
                value={childValue}
              />
            );
          })
        : null}
    </Fragment>
  );
}
