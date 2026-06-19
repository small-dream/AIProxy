import CableRoundedIcon from "@mui/icons-material/CableRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
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
  ListItemButton,
  Stack,
  SvgIcon,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { SessionSummary } from "@aiproxy/shared-types";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { TranslationKey } from "@/i18n";
import { useI18n } from "@/i18n";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getWorkbenchFontSize } from "./SessionInspectorShared";
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

const SESSION_EXPLORER_ROW_HEIGHT = 26;
const SESSION_EXPLORER_OVERSCAN = 12;

type SessionExplorerVisibleRow =
  | { kind: "host"; group: SessionHostGroup }
  | { depth: number; groupKey: string; kind: "node"; node: SessionPathNode };

function getSessionTreeTextSx(theme: Theme) {
  return {
    color: "text.primary",
    fontFamily: theme.typography.fontFamily,
    fontSize: getWorkbenchFontSize(theme, 13),
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
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [localFilterValue, setLocalFilterValue] = useState(domainFilterValue);
  const debouncedFilterValue = useDebouncedValue(localFilterValue, 150);

  // Re-sync when the parent prop changes (e.g. switching to a different container tab).
  useEffect(() => {
    setLocalFilterValue(domainFilterValue);
  }, [domainFilterValue]);

  useEffect(() => {
    onDomainFilterChange(debouncedFilterValue);
  }, [debouncedFilterValue, onDomainFilterChange]);

  const expandedHostSet = useMemo(() => new Set(expandedHosts), [expandedHosts]);

  const visibleRows = useMemo(() => {
    const rows: SessionExplorerVisibleRow[] = [];

    const appendNode = (groupKey: string, node: SessionPathNode, depth: number) => {
      rows.push({ depth, groupKey, kind: "node", node });
      if (node.kind === "branch" && expandedHostSet.has(`${groupKey}::${node.pathKey}`)) {
        for (const child of node.children) {
          appendNode(groupKey, child, depth + 1);
        }
      }
    };

    for (const group of groups) {
      rows.push({ group, kind: "host" });
      if (expandedHostSet.has(group.key)) {
        for (const node of group.tree) {
          appendNode(group.key, node, 0);
        }
      }
    }

    return rows;
  }, [expandedHostSet, groups]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => SESSION_EXPLORER_ROW_HEIGHT,
    overscan: SESSION_EXPLORER_OVERSCAN,
  });

  return (
    <Box
      sx={{
        bgcolor: (theme) =>
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.default, 0.22)
            : alpha(theme.palette.background.default, 0.42),
        borderBottom: { lg: 0, xs: 1 },
        borderColor: "divider",
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <Box ref={scrollContainerRef} sx={{ flex: 1, minHeight: 0, overflow: "auto", py: 0.5 }}>
        {isLoading ? (
          <Stack
            spacing={1.25}
            sx={{
              alignItems: "center",
              px: 2,
              py: 5
            }}>
            <CircularProgress size={22} />
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t("sessionExplorer.loading")}
            </Typography>
          </Stack>
        ) : errorMessage ? (
          <Box sx={{ p: 1.5 }}>
            <Alert severity="error">{errorMessage}</Alert>
          </Box>
        ) : groups.length === 0 ? (
          <Stack
            spacing={1.25}
            sx={{
              alignItems: "center",
              px: 2.5,
              py: 6,
              textAlign: "center"
            }}>
            <Box
              sx={{
                alignItems: "center",
                bgcolor: "action.selected",
                border: "1px solid",
                borderColor: (theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.28 : 0.14),
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
                  fontSize: getWorkbenchFontSize(theme, 17),
                  fontWeight: 700,
                })}
              >
                {t("sessionExplorer.emptyTitle")}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  maxWidth: 320
                }}>
                {t("sessionExplorer.emptyDescription")}
              </Typography>
            </Stack>
            <Typography
              sx={[{
                color: "text.secondary"
              }, (theme) => ({
                fontFamily: theme.typography.fontFamily,
                fontSize: getWorkbenchFontSize(theme, 12.5),
              })]}>
              {t("sessionExplorer.emptyTip")}
            </Typography>
          </Stack>
        ) : (
          <Box
            sx={{
              height: virtualizer.getTotalSize(),
              minWidth: "100%",
              position: "relative",
              width: "max-content",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = visibleRows[virtualItem.index];
              if (!row) return null;

              if (row.kind === "host") {
                const expanded = expandedHostSet.has(row.group.key);
                const hostContextMenu = row.group.host
                  ? (event: React.MouseEvent) => onContextMenuHost?.(row.group.host!, event)
                  : undefined;

                return (
                  <Box
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    style={{
                      position: "absolute",
                      top: virtualItem.start,
                      left: 0,
                      width: "100%",
                      height: virtualItem.size,
                    }}
                  >
                    <HostRow
                      expanded={expanded}
                      group={row.group}
                      onContextMenu={hostContextMenu}
                      onToggle={() => onToggleHost(row.group.key)}
                    />
                  </Box>
                );
              }

              return (
                <Box
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  style={{
                    position: "absolute",
                    top: virtualItem.start,
                    left: 0,
                    width: "100%",
                    height: virtualItem.size,
                  }}
                >
                  <SessionTreeFlatNode
                    depth={row.depth}
                    expanded={
                      row.node.kind === "branch" &&
                      expandedHostSet.has(`${row.groupKey}::${row.node.pathKey}`)
                    }
                    getResourceTooltip={(resourceKind) => getResourceTooltipLabel(resourceKind, t)}
                    groupKey={row.groupKey}
                    node={row.node}
                    onContextMenuHost={onContextMenuHost}
                    onContextMenuSession={onContextMenuSession}
                    onSelectSession={onSelectSession}
                    onToggleHost={onToggleHost}
                    selectedSessionId={selectedSessionId}
                  />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
      <Box
        sx={(theme) => ({
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor:
            theme.palette.mode === "dark"
              ? alpha(theme.palette.common.white, 0.025)
              : alpha(theme.palette.common.white, 0.72),
          boxShadow: `inset 0 1px 0 ${alpha(theme.palette.common.white, theme.palette.mode === "dark" ? 0.03 : 0.55)}`,
          flex: "0 0 auto",
          minHeight: 42,
          px: 1,
          py: 0.75,
        })}
      >
        <InputBase
          aria-label={t("sessionExplorer.filterPlaceholder")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => setLocalFilterValue(event.target.value)}
          placeholder={t("sessionExplorer.filterPlaceholder")}
          spellCheck={false}
          value={localFilterValue}
          sx={(theme) => ({
            color: "text.primary",
            bgcolor: (theme) =>
              alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
            border: "1px solid",
            borderColor: (theme) =>
              alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.5 : 0.7),
            borderRadius: 1.25,
            fontFamily: theme.typography.fontFamily,
            fontSize: getWorkbenchFontSize(theme, 13.5),
            fontWeight: 400,
            lineHeight: 1.25,
            minHeight: 30,
            px: 1.5,
            py: 0.125,
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

function HostRowImpl({ expanded, group, onContextMenu, onToggle }: HostRowProps) {
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
      sx={(theme) => ({
        bgcolor: flashVisible
          ? alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.1 : 0.055)
          : "transparent",
        borderRadius: 1,
        minHeight: 26,
        minWidth: "100%",
        overflow: "hidden",
        position: "relative",
        px: 1,
        py: 0.25,
        transition: "background-color 900ms ease, box-shadow 900ms ease",
        width: "100%",
        "&::before": {
          bgcolor: flashVisible
            ? alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.82 : 0.72)
            : "transparent",
          borderRadius: 999,
          content: '""',
          height: 16,
          left: 2,
          opacity: flashVisible ? 1 : 0,
          position: "absolute",
          top: "50%",
          transform: "translateY(-50%)",
          transition: "opacity 900ms ease, background-color 900ms ease",
          width: 3,
        },
        "&:hover": {
          bgcolor: flashVisible
            ? alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.14 : 0.08)
            : "action.hover",
        },
      })}
    >
      {expanded ? (
        <ExpandMoreRoundedIcon fontSize="small" />
      ) : (
        <ChevronRightRoundedIcon fontSize="small" />
      )}
      <Box
        sx={(theme) => ({
          alignItems: "center",
          color: getHostGroupIconColor(theme, group),
          display: "flex",
          flex: "0 0 auto",
          ml: 0.125,
          mr: 0.25,
        })}
      >
        {renderHostGroupIcon(group)}
      </Box>
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          marginLeft: 0.2,
          maxWidth: "calc(100% - 24px)",
          minWidth: 0,
        }}
      >
        <Typography noWrap sx={(theme) => getSessionTreeTextSx(theme)} variant="body2">
          {group.label}
        </Typography>
      </Box>
    </ListItemButton>
  );
}

type SessionTreeFlatNodeProps = {
  depth: number;
  expanded: boolean;
  getResourceTooltip: (resourceKind: SessionExplorerResourceKind) => string;
  groupKey: string;
  node: SessionPathNode;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (key: string) => void;
  selectedSessionId: string | undefined;
};

function SessionTreeFlatNode({
  depth,
  expanded,
  getResourceTooltip,
  groupKey,
  node,
  onContextMenuHost,
  onContextMenuSession,
  onSelectSession,
  onToggleHost,
  selectedSessionId,
}: SessionTreeFlatNodeProps) {
  if (node.kind === "leaf") {
    return (
      <SessionLeafNode
        depth={depth}
        getResourceTooltip={getResourceTooltip}
        leafLabel={node.segmentLabel}
        onClick={() => onSelectSession(node.session.id)}
        onContextMenu={
          onContextMenuSession
            ? (e) => {
                e.preventDefault();
                onContextMenuSession(node.session, e);
              }
            : undefined
        }
        selected={selectedSessionId === node.session.id}
        session={node.session}
      />
    );
  }

  const expandedKey = `${groupKey}::${node.pathKey}`;
  const branchHost = node.branchType === "host" ? node.host : undefined;

  return (
    <ListItemButton
      dense
      onClick={() => onToggleHost(expandedKey)}
      onContextMenu={
        branchHost
          ? (event) => {
              event.preventDefault();
              onContextMenuHost?.(branchHost, event);
            }
          : undefined
      }
      sx={{
        borderRadius: 1,
        minHeight: 24,
        minWidth: "100%",
        pl: 1.75 + depth * 1.25,
        pr: 1,
        py: 0.125,
        transition: "background-color 140ms ease",
        width: "100%",
        "&:hover": {
          bgcolor: "action.hover",
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
          color: (theme) => getBranchIconColor(theme, node.branchType),
          display: "flex",
          flex: "0 0 auto",
          ml: 0.125,
          mr: 0.25,
        }}
      >
        {renderBranchIcon(node.branchType)}
      </Box>
      <Typography noWrap sx={(theme) => getSessionTreeTextSx(theme)} variant="body2">
        {node.segmentLabel}
      </Typography>
    </ListItemButton>
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

const HostRow = memo(HostRowImpl);

function SessionLeafNodeImpl({
  depth,
  getResourceTooltip,
  leafLabel,
  onClick,
  onContextMenu,
  selected,
  session,
}: SessionLeafNodeProps) {
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
        borderRadius: 1,
        minHeight: 22,
        minWidth: "100%",
        pl: 1.75 + depth * 1.25 + 2,
        position: "relative",
        pr: 1,
        py: 0.125,
        transition: "background-color 140ms ease, color 140ms ease",
        width: "max-content",
        "&:hover": {
          bgcolor: "action.hover",
        },
        "&.Mui-selected": {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.24 : 0.12),
          color: "text.primary",
        },
        "&.Mui-selected::before": {
          bgcolor: "primary.main",
          borderRadius: 999,
          content: '""',
          height: 16,
          left: 2,
          position: "absolute",
          top: "50%",
          transform: "translateY(-50%)",
          width: 3,
        },
        "&.Mui-selected:hover": {
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.3 : 0.16),
        },
      })}
    >
      <Tooltip
        arrow
        placement="top"
        title={buildLeafTooltip(session, resourceKind, getResourceTooltip, t)}
      >
        <Box
          sx={(theme) => ({
            alignItems: "center",
            color: getResourceColor(theme, resourceKind),
            display: "flex",
            flex: "0 0 auto",
            mr: 0.375,
          })}
        >
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
                color: selected ? "text.primary" : "text.secondary",
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

const SessionLeafNode = memo(SessionLeafNodeImpl);

function renderHostGroupIcon(group: SessionHostGroup) {
  const sx = { fontSize: 18.5 };

  if (group.kind === "aggregate") {
    return <UnfocusedGroupIcon data-testid="unfocused-group-icon" sx={sx} />;
  }

  if (group.isFocused) {
    return <FocusedDomainIcon data-testid="focused-host-icon" sx={sx} />;
  }

  return <DomainHostIcon data-testid="host-icon" sx={sx} />;
}

function getHostGroupIconColor(theme: Theme, group: SessionHostGroup): string {
  if (group.kind === "aggregate") {
    return theme.palette.secondary.main;
  }

  if (group.isFocused) {
    return theme.palette.primary.main;
  }

  return theme.palette.text.secondary;
}

function renderBranchIcon(branchType: "host" | "path") {
  if (branchType === "host") {
    return <DomainHostIcon data-testid="aggregate-host-icon" sx={{ fontSize: 17 }} />;
  }

  return <FolderRoundedIcon data-testid="session-folder-icon" sx={{ fontSize: 17 }} />;
}

function getBranchIconColor(theme: Theme, branchType: "host" | "path"): string {
  if (branchType === "host") {
    return theme.palette.text.secondary;
  }

  return theme.palette.mode === "dark" ? "#6FD6F4" : "#5CC8E6";
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

  if (resourceKind === "cancelled") {
    return t("sessionExplorer.resourceKinds.cancelled");
  }

  if (resourceKind === "pending") {
    return t("sessionExplorer.resourceKinds.pending");
  }

  if (resourceKind === "request") {
    return t("sessionExplorer.resourceKinds.request");
  }

  if (resourceKind === "websocket") {
    return t("sessionExplorer.resourceKinds.websocket");
  }

  return t("sessionExplorer.resourceKinds.file");
}

function renderResourceIcon(resourceKind: SessionExplorerResourceKind) {
  const sx = (theme: Theme) => ({
    fontSize: getWorkbenchFontSize(
      theme,
      resourceKind === "warning" || resourceKind === "cancelled" ? 13.5 : 14,
    ),
  });

  if (resourceKind === "api") {
    return <JsonFileIcon sx={sx} />;
  }

  if (resourceKind === "javascript") {
    return (
      <Typography
        sx={(theme) => ({
          fontFamily: theme.typography.fontFamily,
          fontSize: getWorkbenchFontSize(theme, 10),
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
          fontSize: getWorkbenchFontSize(theme, 10),
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

  if (resourceKind === "warning" || resourceKind === "cancelled") {
    return <WarningAmberRoundedIcon sx={sx} />;
  }

  if (resourceKind === "websocket") {
    return <CableRoundedIcon sx={sx} />;
  }

  if (resourceKind === "request") {
    return <InsertDriveFileOutlinedIcon sx={sx} />;
  }

  return <InsertDriveFileOutlinedIcon sx={sx} />;
}

function getResourceColor(theme: Theme, resourceKind: SessionExplorerResourceKind): string {
  if (resourceKind === "pending") {
    return theme.palette.info.main;
  }

  if (resourceKind === "warning") {
    return alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.88 : 0.76);
  }

  if (resourceKind === "cancelled") {
    return theme.palette.warning.dark;
  }

  if (resourceKind === "api") {
    return theme.palette.mode === "dark" ? "#D7DA53" : "#A7AD18";
  }

  if (resourceKind === "javascript") {
    return theme.palette.warning.dark;
  }

  if (resourceKind === "css") {
    return theme.palette.info.dark;
  }

  if (resourceKind === "html") {
    return theme.palette.secondary.main;
  }

  if (resourceKind === "image") {
    return theme.palette.primary.main;
  }

  if (resourceKind === "websocket") {
    return theme.palette.mode === "dark" ? "#4DD0E1" : "#00838F";
  }

  return theme.palette.text.secondary;
}

function JsonFileIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 16 16" data-testid="json-file-icon">
      <path
        d="M5.9 3.35c-.86.36-1.41.89-1.41 1.78v1.23c0 .57-.18.9-.67 1.06v.12c.49.16.67.49.67 1.06v1.23c0 .89.55 1.42 1.41 1.78"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M10.1 3.35c.86.36 1.41.89 1.41 1.78v1.23c0 .57.18.9.67 1.06v.12c-.49.16-.67.49-.67 1.06v1.23c0 .89-.55 1.42-1.41 1.78"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M7.1 4.5 6.4 7.4l.7 2.9M8.9 4.5l.7 2.9-.7 2.9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
    </SvgIcon>
  );
}

const explorerIconStrokeSx = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function DomainHostIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="5.75" strokeWidth="1.5" {...explorerIconStrokeSx} />
      <path
        d="M10 4.4c-1.85 1.42-3 3.52-3 5.6s1.15 4.18 3 5.6"
        strokeWidth="1.35"
        {...explorerIconStrokeSx}
      />
      <path
        d="M10 4.4c1.85 1.42 3 3.52 3 5.6s-1.15 4.18-3 5.6"
        strokeWidth="1.35"
        {...explorerIconStrokeSx}
      />
      <path d="M4.25 10h11.5" strokeWidth="1.35" {...explorerIconStrokeSx} />
      <path
        d="M5.5 7.15c1.25.68 2.86 1.02 4.5 1.02s3.25-.34 4.5-1.02"
        strokeWidth="1.2"
        {...explorerIconStrokeSx}
      />
      <path
        d="M5.5 12.85c1.25-.68 2.86-1.02 4.5-1.02s3.25.34 4.5 1.02"
        strokeWidth="1.2"
        {...explorerIconStrokeSx}
      />
    </SvgIcon>
  );
}

function FocusedDomainIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 20 20">
      <path
        d="M5.15 7.25V5.8c0-.36.29-.65.65-.65h1.45"
        strokeWidth="1.5"
        {...explorerIconStrokeSx}
      />
      <path
        d="M12.75 5.15h1.45c.36 0 .65.29.65.65v1.45"
        strokeWidth="1.5"
        {...explorerIconStrokeSx}
      />
      <path
        d="M14.85 12.75v1.45c0 .36-.29.65-.65.65h-1.45"
        strokeWidth="1.5"
        {...explorerIconStrokeSx}
      />
      <path
        d="M7.25 14.85H5.8a.65.65 0 0 1-.65-.65v-1.45"
        strokeWidth="1.5"
        {...explorerIconStrokeSx}
      />
      <circle cx="10" cy="10" r="3.05" strokeWidth="1.45" {...explorerIconStrokeSx} />
      <path d="M10 8.65v2.7M8.65 10h2.7" strokeWidth="1.35" {...explorerIconStrokeSx} />
    </SvgIcon>
  );
}

function UnfocusedGroupIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 20 20">
      <path
        d="M7.75 7.95 10 9.95m2.25-2 0 0M12.25 7.95 10 9.95M10 12.2v1.55"
        strokeWidth="1.35"
        {...explorerIconStrokeSx}
      />
      <circle cx="6.2" cy="6.2" r="2.1" strokeWidth="1.4" {...explorerIconStrokeSx} />
      <circle cx="13.8" cy="6.2" r="2.1" strokeWidth="1.4" {...explorerIconStrokeSx} />
      <circle cx="10" cy="14.15" r="2.1" strokeWidth="1.4" {...explorerIconStrokeSx} />
      <circle cx="10" cy="10" r="1.05" fill="currentColor" />
    </SvgIcon>
  );
}
