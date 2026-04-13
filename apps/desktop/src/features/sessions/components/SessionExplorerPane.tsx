import ApiRoundedIcon from "@mui/icons-material/ApiRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import HourglassEmptyRoundedIcon from "@mui/icons-material/HourglassEmptyRounded";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  OutlinedInput,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { radiusTokens } from "@pharles/ui-tokens";
import type { SessionSummary } from "@pharles/shared-types";
import { useEffect, useRef, useState } from "react";

import type { TranslationKey } from "@/i18n";
import { useI18n } from "@/i18n";
import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";
import {
  getSessionLeafLabel,
  getSessionQuerySuffix,
  getSessionResourceKind,
  type SessionExplorerResourceKind,
  type SessionHostGroup,
  type SessionPathNode,
} from "../session-explorer.helpers";
import { getMethodColor, getStatusColor } from "./session-inspector.helpers";

type SessionExplorerPaneProps = {
  errorMessage: string | undefined;
  expandedHosts: string[];
  groups: SessionHostGroup[];
  isLoading: boolean;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  searchValue: string;
  selectedSessionId: string | undefined;
};

export function SessionExplorerPane({
  errorMessage,
  expandedHosts,
  groups,
  isLoading,
  onSearchChange,
  onSelectSession,
  onToggleHost,
  searchValue,
  selectedSessionId,
}: SessionExplorerPaneProps) {
  const { t } = useI18n();

  return (
    <Paper
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: `${radiusTokens.card}px`,
        boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
      variant="outlined"
    >
      <Box sx={{ p: 1 }}>
        <OutlinedInput
          fullWidth
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("sessionExplorer.searchPlaceholder")}
          size="small"
          startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
          value={searchValue}
        />
      </Box>

      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {isLoading ? (
          <Stack alignItems="center" spacing={1.25} sx={{ px: 2, py: 5 }}>
            <CircularProgress size={22} />
            <Typography color="text.secondary" variant="body2">
              {t("sessionExplorer.loading")}
            </Typography>
          </Stack>
        ) : errorMessage ? (
          <Box sx={{ p: 1.5 }}>
            <Alert severity="error">{errorMessage}</Alert>
          </Box>
        ) : groups.length === 0 ? (
          <Stack alignItems="center" spacing={1.25} sx={{ px: 2.5, py: 6, textAlign: "center" }}>
            <Box
              sx={{
                alignItems: "center",
                bgcolor: "action.selected",
                border: "1px solid",
                borderColor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.28 : 0.14),
                borderRadius: "50%",
                color: "primary.main",
                display: "flex",
                height: 56,
                justifyContent: "center",
                width: 56,
              }}
            >
              <LanguageRoundedIcon sx={{ fontSize: 28 }} />
            </Box>
            <Stack spacing={0.5}>
              <Typography sx={{ fontSize: 17, fontWeight: 700 }}>{t("sessionExplorer.emptyTitle")}</Typography>
              <Typography color="text.secondary" sx={{ maxWidth: 320 }} variant="body2">
                {t("sessionExplorer.emptyDescription")}
              </Typography>
            </Stack>
            <Typography color="text.secondary" sx={{ fontSize: 12.5 }}>
              {t("sessionExplorer.emptyTip")}
            </Typography>
          </Stack>
        ) : (
          <List disablePadding>
            {groups.map((group) => {
              const expanded = expandedHosts.includes(group.host);

              return (
                <Box key={group.host}>
                  <HostRow
                    expanded={expanded}
                    group={group}
                    onToggle={() => onToggleHost(group.host)}
                  />

                  {expanded ? (
                    <List disablePadding sx={{ pb: 0.25 }}>
                      {group.tree.map((node) => (
                        <SessionTreeNode
                          depth={0}
                          getResourceTooltip={(resourceKind) => getResourceTooltipLabel(resourceKind, t)}
                          host={group.host}
                          key={node.kind === "branch" ? `branch:${node.pathKey}` : `leaf:${node.session.id}`}
                          node={node}
                          onSelectSession={onSelectSession}
                          onToggleHost={onToggleHost}
                          selectedSessionId={selectedSessionId}
                          expandedHosts={expandedHosts}
                        />
                      ))}
                    </List>
                  ) : null}

                </Box>
              );
            })}
          </List>
        )}
      </Box>
    </Paper>
  );
}

type HostRowProps = {
  expanded: boolean;
  group: SessionHostGroup;
  onToggle: () => void;
};

function HostRow({ expanded, group, onToggle }: HostRowProps) {
  const [flashVisible, setFlashVisible] = useState(false);
  const previousLatestStartedAtRef = useRef(group.latestStartedAt);
  const flashTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (previousLatestStartedAtRef.current === group.latestStartedAt) {
      return;
    }

    previousLatestStartedAtRef.current = group.latestStartedAt;
    setFlashVisible(true);

    if (flashTimeoutRef.current) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashVisible(false);
      flashTimeoutRef.current = null;
    }, 2600);
  }, [group.latestStartedAt]);

  return (
    <ListItemButton
      dense
      onClick={onToggle}
      sx={(theme) => ({
        borderRadius: 1.5,
        backgroundColor: flashVisible ? alpha(theme.palette.info.main, 0.16) : "transparent",
        minHeight: 28,
        px: 1.25,
        py: 0.375,
        transition: "background-color 1800ms ease, box-shadow 140ms ease",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
      })}
    >
      {expanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
      <Typography noWrap sx={{ ml: 0.5 }} variant="body2">
        {group.host}
      </Typography>
    </ListItemButton>
  );
}

type SessionTreeNodeProps = {
  depth: number;
  expandedHosts: string[];
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string;
  host: string;
  node: SessionPathNode;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (key: string) => void;
  selectedSessionId: string | undefined;
};

function SessionTreeNode({
  depth,
  expandedHosts,
  getResourceTooltip,
  host,
  node,
  onSelectSession,
  onToggleHost,
  selectedSessionId,
}: SessionTreeNodeProps) {
  if (node.kind === "leaf") {
    return (
      <SessionLeafNode
        depth={depth}
        getResourceTooltip={getResourceTooltip}
        onClick={() => onSelectSession(node.session.id)}
        selected={selectedSessionId === node.session.id}
        session={node.session}
      />
    );
  }

  const expandedKey = `${host}::${node.pathKey}`;
  const expanded = expandedHosts.includes(expandedKey);

  return (
    <>
      <ListItemButton
        dense
        onClick={() => onToggleHost(expandedKey)}
        sx={{
          borderRadius: 1.5,
          minHeight: 26,
          pl: 2 + depth * 1.5,
          pr: 1,
          py: 0.25,
          transition: "background-color 140ms ease, box-shadow 140ms ease",
          "&:hover": {
            boxShadow: (theme) => getHoverShadow(theme.palette.mode),
          },
        }}
      >
        {expanded ? (
          <ExpandMoreRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
        ) : (
          <ChevronRightRoundedIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
        )}
        <Typography noWrap sx={{ color: "text.secondary", fontSize: 12.5, ml: 0.25 }} variant="body2">
          {node.segmentLabel}
        </Typography>
      </ListItemButton>

      {expanded
        ? node.children.map((childNode) => (
            <SessionTreeNode
              depth={depth + 1}
              expandedHosts={expandedHosts}
              getResourceTooltip={getResourceTooltip}
              host={host}
              key={childNode.kind === "branch" ? `branch:${childNode.pathKey}` : `leaf:${childNode.session.id}`}
              node={childNode}
              onSelectSession={onSelectSession}
              onToggleHost={onToggleHost}
              selectedSessionId={selectedSessionId}
            />
          ))
        : null}
    </>
  );
}

type SessionLeafNodeProps = {
  depth: number;
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string;
  onClick: () => void;
  selected: boolean;
  session: SessionSummary;
};

function SessionLeafNode({ depth, getResourceTooltip, onClick, selected, session }: SessionLeafNodeProps) {
  const { t } = useI18n();
  const resourceKind = getSessionResourceKind(session);
  const querySuffix = getSessionQuerySuffix(session);

  return (
    <ListItemButton
      dense
      onClick={onClick}
      selected={selected}
      sx={{
        borderRadius: 1.5,
        minHeight: 30,
        pl: 2 + depth * 1.5 + 2,
        pr: 1,
        py: 0.375,
        transition: "background-color 140ms ease, box-shadow 140ms ease",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
        "&.Mui-selected": {
          bgcolor: "action.selected",
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
      }}
    >
      <Chip
        color={getMethodColor(session.method)}
        label={session.method}
        size="small"
        sx={{
          flex: "0 0 auto",
          fontSize: 10,
          fontWeight: 700,
          height: 18,
          mr: 0.75,
          minWidth: 46,
          "& .MuiChip-label": {
            px: 0.75,
          },
        }}
      />
      <Tooltip arrow placement="top" title={buildLeafTooltip(session, resourceKind, getResourceTooltip, t)}>
        <Box sx={{ alignItems: "center", color: getResourceColor(resourceKind), display: "flex", flex: "0 0 auto", mr: 0.75 }}>
          {renderResourceIcon(resourceKind)}
        </Box>
      </Tooltip>
      <Typography noWrap sx={{ flex: 1, minWidth: 0 }} variant="body2">
        {getSessionLeafLabel(session)}
      </Typography>
      {querySuffix ? (
        <Typography noWrap sx={{ color: "text.disabled", flex: "0 1 auto", ml: 0.5 }} variant="caption">
          {querySuffix}
        </Typography>
      ) : null}
      <Chip
        color={getStatusColor(session.statusCode)}
        label={session.statusCode > 0 ? String(session.statusCode) : "--"}
        size="small"
        sx={{
          flex: "0 0 auto",
          fontSize: 10,
          fontWeight: 700,
          height: 18,
          ml: 0.75,
          minWidth: 42,
          "& .MuiChip-label": {
            px: 0.75,
          },
        }}
        variant="outlined"
      />
    </ListItemButton>
  );
}

function buildLeafTooltip(
  session: SessionSummary,
  resourceKind: SessionExplorerResourceKind,
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string,
  t: (key: TranslationKey, params?: Record<string, number | string>) => string,
): string {
  const kindLabel = getResourceTooltip(resourceKind);

  if (session.statusCode <= 0) {
    return t("sessionExplorer.tooltipPending", { method: session.method, url: session.url });
  }

  return t("sessionExplorer.tooltipResolved", {
    kind: kindLabel,
    method: session.method,
    statusCode: session.statusCode,
    url: session.url,
  });
}

function getResourceTooltipLabel(
  resourceKind: SessionExplorerResourceKind,
  t: (key: TranslationKey) => string,
): string {
  if (resourceKind === "api") {
    return t("sessionExplorer.resourceKinds.json");
  }

  if (resourceKind === "javascript") {
    return t("sessionExplorer.resourceKinds.javascript");
  }

  if (resourceKind === "css") {
    return t("sessionExplorer.resourceKinds.css");
  }

  if (resourceKind === "html") {
    return t("sessionExplorer.resourceKinds.html");
  }

  if (resourceKind === "image") {
    return t("sessionExplorer.resourceKinds.image");
  }

  if (resourceKind === "text") {
    return t("sessionExplorer.resourceKinds.text");
  }

  if (resourceKind === "warning") {
    return t("sessionExplorer.resourceKinds.failed");
  }

  if (resourceKind === "pending") {
    return t("sessionExplorer.resourceKinds.pending");
  }

  if (resourceKind === "request") {
    return t("sessionExplorer.resourceKinds.request");
  }

  return t("sessionExplorer.resourceKinds.file");
}

function renderResourceIcon(resourceKind: SessionExplorerResourceKind) {
  const sx = { fontSize: 14 };

  if (resourceKind === "api") {
    return <ApiRoundedIcon sx={sx} />;
  }

  if (resourceKind === "javascript") {
    return <Typography sx={{ fontSize: 10, fontWeight: 700, lineHeight: 1 }}>JS</Typography>;
  }

  if (resourceKind === "css") {
    return <Typography sx={{ fontSize: 10, fontWeight: 700, lineHeight: 1 }}>CSS</Typography>;
  }

  if (resourceKind === "html") {
    return <LanguageRoundedIcon sx={sx} />;
  }

  if (resourceKind === "image") {
    return <ImageOutlinedIcon sx={sx} />;
  }

  if (resourceKind === "text") {
    return <DescriptionOutlinedIcon sx={sx} />;
  }

  if (resourceKind === "pending") {
    return <HourglassEmptyRoundedIcon sx={sx} />;
  }

  if (resourceKind === "warning") {
    return <WarningAmberRoundedIcon sx={sx} />;
  }

  if (resourceKind === "request") {
    return <ChevronRightRoundedIcon sx={sx} />;
  }

  return <InsertDriveFileOutlinedIcon sx={sx} />;
}

function getResourceColor(resourceKind: SessionExplorerResourceKind): string {
  if (resourceKind === "pending") {
    return "info.main";
  }

  if (resourceKind === "warning") {
    return "error.main";
  }

  if (resourceKind === "api") {
    return "success.main";
  }

  if (resourceKind === "javascript") {
    return "warning.dark";
  }

  if (resourceKind === "css") {
    return "info.dark";
  }

  if (resourceKind === "html") {
    return "secondary.main";
  }

  if (resourceKind === "image") {
    return "primary.main";
  }

  return "text.secondary";
}
