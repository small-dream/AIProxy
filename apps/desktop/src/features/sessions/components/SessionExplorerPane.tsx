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
  InputBase,
  List,
  ListItemButton,
  Stack,
  SvgIcon,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { SessionSummary } from "@aiproxy/shared-types";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import { useEffect, useRef, useState } from "react";

import type { TranslationKey } from "@/i18n";
import { useI18n } from "@/i18n";
import { getHoverShadow } from "@/themes/app-theme";
import { defaultAppFontSize } from "@/themes/fonts";
import {
  getSessionQuerySuffix,
  getSessionResourceKind,
  type SessionExplorerResourceKind,
  type SessionHostGroup,
  type SessionPathNode,
} from "../session-explorer.helpers";

type SessionExplorerPaneProps = {
  domainFilterValue: string;
  errorMessage: string | undefined;
  expandedHosts: string[];
  groups: SessionHostGroup[];
  isLoading: boolean;
  onDomainFilterChange: (value: string) => void;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  selectedSessionId: string | undefined;
};

function getScaledFontSize(theme: Theme, basePx: number): string {
  return `${(theme.typography.fontSize / defaultAppFontSize) * basePx}px`;
}

function getSessionTreeTextSx(theme: Theme) {
  return {
    color: "text.primary",
    fontFamily: theme.typography.fontFamily,
    fontSize: getScaledFontSize(theme, 13),
    fontWeight: 400,
    lineHeight: 1.35,
  } as const;
}

export function SessionExplorerPane({
  domainFilterValue,
  errorMessage,
  expandedHosts,
  groups,
  isLoading,
  onDomainFilterChange,
  onContextMenuHost,
  onContextMenuSession,
  onSelectSession,
  onToggleHost,
  selectedSessionId,
}: SessionExplorerPaneProps) {
  const { t } = useI18n();

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        borderBottom: { lg: 0, xs: 1 },
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
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
              <Typography
                sx={(theme) => ({
                  fontFamily: theme.typography.fontFamily,
                  fontSize: getScaledFontSize(theme, 17),
                  fontWeight: 700,
                })}
              >
                {t("sessionExplorer.emptyTitle")}
              </Typography>
              <Typography color="text.secondary" sx={{ maxWidth: 320 }} variant="body2">
                {t("sessionExplorer.emptyDescription")}
              </Typography>
            </Stack>
            <Typography
              color="text.secondary"
              sx={(theme) => ({
                fontFamily: theme.typography.fontFamily,
                fontSize: getScaledFontSize(theme, 12.5),
              })}
            >
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

      <Box
        sx={(theme) => ({
          borderTop: "1px solid",
          borderColor: alpha(theme.palette.common.black, theme.palette.mode === "dark" ? 0.28 : 0.12),
          bgcolor: theme.palette.mode === "dark" ? alpha(theme.palette.common.white, 0.02) : alpha(theme.palette.common.black, 0.015),
          boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, theme.palette.mode === "dark" ? 0.03 : 0.55)}`,
          flex: "0 0 auto",
          minHeight: 34,
          px: 0,
          py: 0,
        })}
      >
        <InputBase
          aria-label={t("sessionExplorer.filterPlaceholder")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => onDomainFilterChange(event.target.value)}
          placeholder={t("sessionExplorer.filterPlaceholder")}
          spellCheck={false}
          value={domainFilterValue}
          sx={(theme) => ({
            color: "text.primary",
            fontFamily: theme.typography.fontFamily,
            fontSize: getScaledFontSize(theme, 13.5),
            fontWeight: 400,
            lineHeight: 1.25,
            minHeight: 34,
            px: 1.5,
            py: 0.25,
            width: "100%",
            "& input": {
              padding: 0,
            },
            "& input::placeholder": {
              color: theme.palette.text.disabled,
              opacity: 1,
            },
          })}
        />
      </Box>
    </Box>
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
        borderRadius: 0,
        minHeight: 26,
        minWidth: "100%",
        px: 1,
        py: 0.25,
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
        <Typography noWrap sx={(theme) => getSessionTreeTextSx(theme)} variant="body2">
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
          borderRadius: 0,
          minHeight: 24,
          minWidth: "100%",
          pl: 1.75 + depth * 1.25,
          pr: 1,
          py: 0.125,
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
          sx={(theme) => getSessionTreeTextSx(theme)}
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
      sx={(theme) => ({
        borderRadius: 0,
        minHeight: 22,
        minWidth: "100%",
        pl: 1.75 + depth * 1.25 + 2,
        pr: 1,
        py: 0.125,
        transition: "background-color 140ms ease, box-shadow 140ms ease",
        width: "max-content",
        "&:hover": {
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
        "&.Mui-selected": {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.32 : 0.18),
          borderRadius: 0,
          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
        },
        "&.Mui-selected:hover": {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.36 : 0.22),
        },
      })}
    >
      <Tooltip arrow placement="top" title={buildLeafTooltip(session, resourceKind, getResourceTooltip, t)}>
        <Box sx={{ alignItems: "center", color: getResourceColor(resourceKind), display: "flex", flex: "0 0 auto", mr: 0.375 }}>
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
            gap: showLeafLabel && querySuffix ? 0.0625 : 0,
            width: "max-content",
          }}
        >
          {showLeafLabel ? (
            <Typography
              sx={(theme) => ({
                ...getSessionTreeTextSx(theme),
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              })}
              variant="body2"
            >
              {leafLabel}
            </Typography>
          ) : null}
          {querySuffix ? (
            <Typography
              sx={(theme) => ({
                ...getSessionTreeTextSx(theme),
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              })}
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
  const sx = (theme: Theme) => ({ fontSize: getScaledFontSize(theme, 14) });

  if (resourceKind === "api") {
    return <JsonFileIcon sx={sx} />;
  }

  if (resourceKind === "javascript") {
    return (
      <Typography
        sx={(theme) => ({
          fontFamily: theme.typography.fontFamily,
          fontSize: getScaledFontSize(theme, 10),
          fontWeight: 700,
          lineHeight: 1,
        })}
      >
        JS
      </Typography>
    );
  }

  if (resourceKind === "css") {
    return (
      <Typography
        sx={(theme) => ({
          fontFamily: theme.typography.fontFamily,
          fontSize: getScaledFontSize(theme, 10),
          fontWeight: 700,
          lineHeight: 1,
        })}
      >
        CSS
      </Typography>
    );
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

function JsonFileIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 16 16" data-testid="json-file-icon">
      <path
        d="M4 1.75h5.4L12.75 5v8.25A1.75 1.75 0 0 1 11 15H4A1.75 1.75 0 0 1 2.25 13.25v-9.75A1.75 1.75 0 0 1 4 1.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M9.25 1.75V4A1 1 0 0 0 10.25 5h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M5.35 8.15c-.48 0-.8.34-.8.85s.32.85.8.85M10.65 8.15c.48 0 .8.34.8.85s-.32.85-.8.85"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1"
      />
      <path
        d="M6.75 7.5h2.5M6.75 8.8h2.5M6.75 10.1h2.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth=".9"
      />
    </SvgIcon>
  );
}
