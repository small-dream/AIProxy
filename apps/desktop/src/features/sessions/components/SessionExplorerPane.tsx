import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Box,
  CircularProgress,
  List,
  ListItemButton,
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
  getSessionQuerySuffix,
  getSessionResourceKind,
  type SessionExplorerResourceKind,
  type SessionHostGroup,
  type SessionPathNode,
} from "../session-explorer.helpers";

type SessionExplorerPaneProps = {
  errorMessage: string | undefined;
  expandedHosts: string[];
  groups: SessionHostGroup[];
  isLoading: boolean;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  selectedSessionId: string | undefined;
};

const sessionTreeTextSx = {
  color: "text.primary",
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1.35,
} as const;

export function SessionExplorerPane({
  errorMessage,
  expandedHosts,
  groups,
  isLoading,
  onContextMenuHost,
  onContextMenuSession,
  onSelectSession,
  onToggleHost,
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
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
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
          <List disablePadding sx={{ minWidth: "100%", width: "max-content" }}>
            {groups.map((group) => {
              const expanded = expandedHosts.includes(group.key);
              const hostContextMenu = group.host
                ? (event: React.MouseEvent) => onContextMenuHost?.(group.host!, event)
                : undefined;

              return (
                <Box key={group.key} sx={{ minWidth: "100%", width: "max-content" }}>
                  <HostRow
                    expanded={expanded}
                    group={group}
                    onContextMenu={hostContextMenu}
                    onToggle={() => onToggleHost(group.key)}
                  />

                  {expanded ? (
                    <List disablePadding sx={{ minWidth: "100%", pb: 0.25, width: "max-content" }}>
                      {group.tree.map((node) => (
                        <SessionTreeNode
                          depth={0}
                          getResourceTooltip={(resourceKind) => getResourceTooltipLabel(resourceKind, t)}
                          groupKey={group.key}
                          key={node.kind === "branch" ? `branch:${node.pathKey}` : `leaf:${node.session.id}`}
                          node={node}
                          onContextMenuHost={onContextMenuHost}
                          onContextMenuSession={onContextMenuSession}
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
  onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  onToggle: () => void;
};

function HostRow({ expanded, group, onContextMenu, onToggle }: HostRowProps) {
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
      onContextMenu={onContextMenu}
      sx={{
        borderRadius: 1.5,
        minHeight: 28,
        minWidth: "100%",
        px: 1.25,
        py: 0.375,
        transition: "box-shadow 140ms ease",
        width: "100%",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
      }}
    >
      {expanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
      <Box
        component="span"
        sx={(theme) => ({
          backgroundColor: flashVisible ? alpha(theme.palette.info.main, 0.16) : "transparent",
          display: "inline-flex",
          marginLeft: 0.5,
          maxWidth: "calc(100% - 24px)",
          minWidth: 0,
          transition: "background-color 1800ms ease",
        })}
      >
        <Typography noWrap sx={sessionTreeTextSx} variant="body2">
          {group.label}
        </Typography>
      </Box>
    </ListItemButton>
  );
}

type SessionTreeNodeProps = {
  depth: number;
  expandedHosts: string[];
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string;
  groupKey: string;
  node: SessionPathNode;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (key: string) => void;
  selectedSessionId: string | undefined;
};

function SessionTreeNode({
  depth,
  expandedHosts,
  getResourceTooltip,
  groupKey,
  node,
  onContextMenuHost,
  onContextMenuSession,
  onSelectSession,
  onToggleHost,
  selectedSessionId,
}: SessionTreeNodeProps) {
  if (node.kind === "leaf") {
    return (
      <SessionLeafNode
        depth={depth}
        getResourceTooltip={getResourceTooltip}
        leafLabel={node.segmentLabel}
        onClick={() => onSelectSession(node.session.id)}
        onContextMenu={onContextMenuSession ? (e) => { e.preventDefault(); onContextMenuSession(node.session, e); } : undefined}
        selected={selectedSessionId === node.session.id}
        session={node.session}
      />
    );
  }

  const expandedKey = `${groupKey}::${node.pathKey}`;
  const expanded = expandedHosts.includes(expandedKey);
  const branchHost = node.branchType === "host" ? node.host : undefined;

  return (
    <Box sx={{ minWidth: "100%", width: "max-content" }}>
      <ListItemButton
        dense
        onClick={() => onToggleHost(expandedKey)}
        onContextMenu={branchHost
          ? (event) => {
              event.preventDefault();
              onContextMenuHost?.(branchHost, event);
            }
          : undefined}
        sx={{
          borderRadius: 1.5,
          minHeight: 26,
          minWidth: "100%",
          pl: 2 + depth * 1.5,
          pr: 1,
          py: 0.25,
          transition: "background-color 140ms ease, box-shadow 140ms ease",
          width: "100%",
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
        <Box
          sx={{
            alignItems: "center",
            color: "info.main",
            display: "flex",
            flex: "0 0 auto",
            ml: 0.125,
            mr: 0.5,
          }}
        >
          {expanded ? <FolderOpenRoundedIcon sx={{ fontSize: 16 }} /> : <FolderRoundedIcon sx={{ fontSize: 16 }} />}
        </Box>
        <Typography
          noWrap
          sx={sessionTreeTextSx}
          variant="body2"
        >
          {node.segmentLabel}
        </Typography>
      </ListItemButton>

      {expanded ? (
        <Box sx={{ minWidth: "100%", width: "max-content" }}>
          {node.children.map((childNode) => (
            <SessionTreeNode
              depth={depth + 1}
              expandedHosts={expandedHosts}
              getResourceTooltip={getResourceTooltip}
              groupKey={groupKey}
              key={childNode.kind === "branch" ? `branch:${childNode.pathKey}` : `leaf:${childNode.session.id}`}
              node={childNode}
              onContextMenuHost={onContextMenuHost}
              onContextMenuSession={onContextMenuSession}
              onSelectSession={onSelectSession}
              onToggleHost={onToggleHost}
              selectedSessionId={selectedSessionId}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

type SessionLeafNodeProps = {
  depth: number;
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string;
  leafLabel: string;
  onClick: () => void;
  onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  selected: boolean;
  session: SessionSummary;
};

function SessionLeafNode({ depth, getResourceTooltip, leafLabel, onClick, onContextMenu, selected, session }: SessionLeafNodeProps) {
  const { t } = useI18n();
  const resourceKind = getSessionResourceKind(session);
  const querySuffix = getSessionQuerySuffix(session);
  const showLeafLabel = leafLabel.length > 0;

  return (
    <ListItemButton
      dense
      onClick={onClick}
      onContextMenu={onContextMenu}
      selected={selected}
      sx={{
        borderRadius: 1.5,
        minHeight: 30,
        minWidth: "100%",
        pl: 2 + depth * 1.5 + 2,
        pr: 1,
        py: 0.375,
        transition: "background-color 140ms ease, box-shadow 140ms ease",
        width: "max-content",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
        "&.Mui-selected": {
          bgcolor: "action.selected",
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
      }}
    >
      <Tooltip arrow placement="top" title={buildLeafTooltip(session, resourceKind, getResourceTooltip, t)}>
        <Box sx={{ alignItems: "center", color: getResourceColor(resourceKind), display: "flex", flex: "0 0 auto", mr: 0.75 }}>
          {renderResourceIcon(resourceKind)}
        </Box>
      </Tooltip>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            alignItems: "baseline",
            display: "flex",
            gap: showLeafLabel && querySuffix ? 0.125 : 0,
            width: "max-content",
          }}
        >
          {showLeafLabel ? (
            <Typography
              sx={{
                ...sessionTreeTextSx,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
              variant="body2"
            >
              {leafLabel}
            </Typography>
          ) : null}
          {querySuffix ? (
            <Typography
              sx={{
                ...sessionTreeTextSx,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
              variant="body2"
            >
              {querySuffix}
            </Typography>
          ) : null}
        </Box>
      </Box>
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
    return <InsertDriveFileOutlinedIcon sx={sx} />;
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
    return <CircularProgress color="inherit" size={12} thickness={6} />;
  }

  if (resourceKind === "warning") {
    return <WarningAmberRoundedIcon sx={sx} />;
  }

  if (resourceKind === "request") {
    return <InsertDriveFileOutlinedIcon sx={sx} />;
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
    return "text.secondary";
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
