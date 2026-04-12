import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { IconButton, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import { formatJsonPrimitive, isJsonObject, jsonSubtreeMatches, type JsonValue } from "./session-inspector.helpers";
import { renderHighlightedText } from "./SessionInspectorShared";

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

  return (
    <Stack spacing={0.5}>
      <JsonTreeNode
        expandedPaths={expandedPaths}
        onTogglePath={togglePath}
        path="root"
        searchQuery={searchQuery}
        value={value}
      />
    </Stack>
  );
}

function JsonTreeNode({
  expandedPaths,
  name,
  onTogglePath,
  path,
  searchQuery,
  value,
}: {
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

  if (!hasChildren) {
    return (
      <Stack direction="row" spacing={1} sx={{ pl: path === "root" ? 0 : 3 }}>
        {name ? (
          <Typography sx={{ color: "info.main", whiteSpace: "pre-wrap", wordBreak: "break-word" }} variant="body2">
            {renderHighlightedText(`"${name}"`, searchQuery)}:
          </Typography>
        ) : null}
        <Typography sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }} variant="body2">
          {renderHighlightedText(formatJsonPrimitive(value), searchQuery)}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={0.5} sx={{ pl: path === "root" ? 0 : 1.5 }}>
      <Stack alignItems="center" direction="row" spacing={0.5}>
        <IconButton onClick={() => onTogglePath(path)} size="small" sx={{ p: 0.25 }}>
          {isExpanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
        </IconButton>
        {name ? (
          <Typography sx={{ color: "info.main", whiteSpace: "pre-wrap", wordBreak: "break-word" }} variant="body2">
            {renderHighlightedText(`"${name}"`, searchQuery)}:
          </Typography>
        ) : null}
        <Typography color="text.secondary" variant="body2">
          {Array.isArray(value) ? `[${children.length}]` : `{${children.length}}`}
        </Typography>
      </Stack>

      {isExpanded ? (
        <Stack spacing={0.5}>
          {children.map(([childName, childValue]) => {
            const childPath = `${path}.${childName}`;

            return Array.isArray(value) ? (
              <JsonTreeNode
                expandedPaths={expandedPaths}
                key={childPath}
                onTogglePath={onTogglePath}
                path={childPath}
                searchQuery={searchQuery}
                value={childValue}
              />
            ) : (
              <JsonTreeNode
                expandedPaths={expandedPaths}
                key={childPath}
                name={childName}
                onTogglePath={onTogglePath}
                path={childPath}
                searchQuery={searchQuery}
                value={childValue}
              />
            );
          })}
        </Stack>
      ) : null}
    </Stack>
  );
}
