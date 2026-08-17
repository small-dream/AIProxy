import CableRoundedIcon from "@mui/icons-material/CableRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
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
import { useBreakpointStore } from "@/features/breakpoints/breakpoint.store";
import { SessionFilterChips } from "./SessionFilterChips";
import { getWorkbenchFontSize } from "./SessionInspectorShared";
import {
  getSessionQuerySuffix,
  getSessionResourceKind,
  type SessionExplorerResourceKind,
  type SessionHostGroup,
  type SessionPathBranch,
  type SessionPathNode,
} from "../session-explorer.helpers";

type SessionExplorerPaneProps = {
  errorMessage: string | undefined;
  expandedHosts: string[];
  focusedHosts: ReadonlySet<string>;
  groups: SessionHostGroup[];
  ignoredHosts: ReadonlySet<string>;
  isLoading: boolean;
  multiSelectedSessionIds: ReadonlySet<string>;
  onClearMultiSelection: () => void;
  onDisableThrottledOnly: () => void;
  onDeleteSelected: () => void;
  onExportSelected: () => void;
  onContextMenuFolder?: ((node: SessionPathBranch, event: React.MouseEvent) => void) | undefined;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSaveSelectedResponses: () => void;
  onSelectSession: (sessionId: string, options?: { additive?: boolean; range?: boolean }) => void;
  onSearchValueChange: (value: string) => void;
  onStopIgnoringHost: (host: string) => void;
  onToggleHost: (host: string) => void;
  onUnfocusHost: (host: string) => void;
  searchValue: string;
  selectedSessionId: string | undefined;
  showOnlyThrottled: boolean;
  visibleSessionOrder: string[];
};

const SESSION_EXPLORER_ROW_HEIGHT = 26;
const SESSION_EXPLORER_OVERSCAN = 12;

function BatchActionButton({
  destructive = false,
  label,
  onClick,
}: {
  destructive?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Box
      aria-label={label}
      component="button"
      onClick={onClick}
      role="button"
      tabIndex={0}
      sx={(theme) => ({
        bgcolor: destructive
          ? alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.18 : 0.08)
          : "transparent",
        border: "1px solid",
        borderColor: destructive ? alpha(theme.palette.error.main, 0.45) : theme.palette.divider,
        borderRadius: 1,
        color: destructive ? "error.main" : "text.secondary",
        cursor: "pointer",
        flex: "0 0 auto",
        fontFamily: theme.typography.fontFamily,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        px: 0.75,
        py: 0.5,
        "&:hover": {
          bgcolor: destructive
            ? alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.28 : 0.14)
            : "action.hover",
          color: destructive ? "error.main" : "text.primary",
        },
      })}
    >
      {label}
    </Box>
  );
}

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
  errorMessage,
  expandedHosts,
  focusedHosts,
  groups,
  ignoredHosts,
  isLoading,
  multiSelectedSessionIds,
  onClearMultiSelection,
  onDisableThrottledOnly,
  onDeleteSelected,
  onExportSelected,
  onContextMenuFolder,
  onContextMenuHost,
  onContextMenuSession,
  onSaveSelectedResponses,
  onSelectSession,
  onSearchValueChange,
  onStopIgnoringHost,
  onToggleHost,
  onUnfocusHost,
  searchValue,
  selectedSessionId,
  showOnlyThrottled,
  visibleSessionOrder,
}: SessionExplorerPaneProps) {
  const { t } = useI18n();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [localFilterValue, setLocalFilterValue] = useState(searchValue);
  const debouncedFilterValue = useDebouncedValue(localFilterValue, 150);
  const pendingBreakpointHits = useBreakpointStore((s) => s.pendingHits);

  const pendingBreakpointSessionIds = useMemo(
    () => new Set(pendingBreakpointHits.map((hit) => hit.sessionId)),
    [pendingBreakpointHits],
  );

  // Re-sync when the parent prop changes (e.g. switching to a different container tab).
  useEffect(() => {
    setLocalFilterValue(searchValue);
  }, [searchValue]);

  useEffect(() => {
    onSearchValueChange(debouncedFilterValue);
  }, [debouncedFilterValue, onSearchValueChange]);

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

  const navigateWithKeyboard = useMemo(
    () => (direction: "up" | "down" | "home" | "end") => {
      if (visibleSessionOrder.length === 0) return;

      const currentIndex = visibleSessionOrder.indexOf(selectedSessionId ?? "");
      let nextIndex: number;

      if (direction === "home") {
        nextIndex = 0;
      } else if (direction === "end") {
        nextIndex = visibleSessionOrder.length - 1;
      } else if (currentIndex === -1) {
        nextIndex = 0;
      } else if (direction === "down") {
        nextIndex = Math.min(currentIndex + 1, visibleSessionOrder.length - 1);
      } else {
        nextIndex = Math.max(currentIndex - 1, 0);
      }

      const nextSessionId = visibleSessionOrder[nextIndex];
      if (!nextSessionId || nextSessionId === selectedSessionId) return;

      onSelectSession(nextSessionId);
      window.requestAnimationFrame(() => {
        const element = scrollContainerRef.current?.querySelector<HTMLElement>(
          `[data-session-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(nextSessionId) : nextSessionId}"]`,
        );
        element?.scrollIntoView?.({ block: "nearest" });
      });
    },
    [onSelectSession, selectedSessionId, visibleSessionOrder],
  );

  const handleExplorerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      navigateWithKeyboard(event.key === "ArrowDown" ? "down" : "up");
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      navigateWithKeyboard("home");
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      navigateWithKeyboard("end");
      return;
    }

    if (event.key === "Escape" && multiSelectedSessionIds.size > 0) {
      event.preventDefault();
      onClearMultiSelection();
    }
  };

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
      <SessionFilterChips
        focusedHosts={focusedHosts}
        ignoredHosts={ignoredHosts}
        showOnlyThrottled={showOnlyThrottled}
        onDisableThrottledOnly={onDisableThrottledOnly}
        onStopIgnoringHost={onStopIgnoringHost}
        onUnfocusHost={onUnfocusHost}
      />

      {multiSelectedSessionIds.size > 0 ? (
        <Box
          sx={(theme) => ({
            alignItems: "center",
            bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.06),
            borderBottom: "1px solid",
            borderColor: "divider",
            display: "flex",
            gap: 0.75,
            px: 1,
            py: 0.5,
          })}
        >
          <Typography
            noWrap
            sx={{
              color: "text.secondary",
              flex: 1,
              fontSize: 12.5,
              fontWeight: 600,
              minWidth: 0,
            }}
            variant="body2"
          >
            {t("sessionExplorer.batchSelected", { count: multiSelectedSessionIds.size })}
          </Typography>
          <BatchActionButton label={t("sessionExplorer.batchExport")} onClick={onExportSelected} />
          <BatchActionButton
            label={t("sessionExplorer.batchSaveResponses")}
            onClick={onSaveSelectedResponses}
          />
          <BatchActionButton
            destructive
            label={t("sessionExplorer.batchDelete")}
            onClick={onDeleteSelected}
          />
          <BatchActionButton
            label={t("sessionExplorer.batchClear")}
            onClick={onClearMultiSelection}
          />
        </Box>
      ) : null}

      <Box
        ref={scrollContainerRef}
        onKeyDown={handleExplorerKeyDown}
        role="listbox"
        tabIndex={0}
        sx={{
          flex: 1,
          minHeight: 0,
          outline: "none",
          overflow: "auto",
          py: 0.5,
        }}
      >
        {isLoading ? (
          <Stack
            spacing={1.25}
            sx={{
              alignItems: "center",
              px: 2,
              py: 5,
            }}
          >
            <CircularProgress size={22} />
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
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
              textAlign: "center",
            }}
          >
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
                  maxWidth: 320,
                }}
              >
                {t("sessionExplorer.emptyDescription")}
              </Typography>
            </Stack>
            <Typography
              sx={[
                {
                  color: "text.secondary",
                },
                (theme) => ({
                  fontFamily: theme.typography.fontFamily,
                  fontSize: getWorkbenchFontSize(theme, 12.5),
                }),
              ]}
            >
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
                  data-session-id={row.node.kind === "leaf" ? row.node.session.id : undefined}
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
                    multiSelectedSessionIds={multiSelectedSessionIds}
                    node={row.node}
                    onContextMenuFolder={onContextMenuFolder}
                    onContextMenuHost={onContextMenuHost}
                    onContextMenuSession={onContextMenuSession}
                    onSelectSession={onSelectSession}
                    onToggleHost={onToggleHost}
                    pendingBreakpointSessionIds={pendingBreakpointSessionIds}
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
  multiSelectedSessionIds: ReadonlySet<string>;
  node: SessionPathNode;
  onContextMenuFolder?: ((node: SessionPathBranch, event: React.MouseEvent) => void) | undefined;
  onContextMenuHost?: ((host: string, event: React.MouseEvent) => void) | undefined;
  onContextMenuSession?: ((session: SessionSummary, event: React.MouseEvent) => void) | undefined;
  onSelectSession: (sessionId: string, options?: { additive?: boolean; range?: boolean }) => void;
  onToggleHost: (key: string) => void;
  pendingBreakpointSessionIds: ReadonlySet<string>;
  selectedSessionId: string | undefined;
};

function SessionTreeFlatNode({
  depth,
  expanded,
  getResourceTooltip,
  groupKey,
  multiSelectedSessionIds,
  node,
  onContextMenuFolder,
  onContextMenuHost,
  onContextMenuSession,
  onSelectSession,
  onToggleHost,
  pendingBreakpointSessionIds,
  selectedSessionId,
}: SessionTreeFlatNodeProps) {
  if (node.kind === "leaf") {
    return (
      <SessionLeafNode
        depth={depth}
        getResourceTooltip={getResourceTooltip}
        leafLabel={node.segmentLabel}
        isMultiSelected={multiSelectedSessionIds.has(node.session.id)}
        isPendingBreakpoint={pendingBreakpointSessionIds.has(node.session.id)}
        onClick={(event) => {
          const additive = event.metaKey || event.ctrlKey;
          const range = event.shiftKey;
          onSelectSession(node.session.id, {
            additive,
            range,
          });
        }}
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
  // Host branches keep the host-scoped menu (focus/ignore/export); path
  // branches — the "folders" of the tree — get the folder menu instead.
  const handleBranchContextMenu = branchHost
    ? (event: React.MouseEvent) => {
        event.preventDefault();
        onContextMenuHost?.(branchHost, event);
      }
    : onContextMenuFolder
      ? (event: React.MouseEvent) => {
          event.preventDefault();
          onContextMenuFolder(node, event);
        }
      : undefined;

  return (
    <ListItemButton
      dense
      onClick={() => onToggleHost(expandedKey)}
      onContextMenu={handleBranchContextMenu}
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
  isMultiSelected: boolean;
  isPendingBreakpoint: boolean;
  leafLabel: string;
  onClick: (event: React.MouseEvent) => void;
  onContextMenu?: ((event: React.MouseEvent) => void) | undefined;
  selected: boolean;
  session: SessionSummary;
};

const HostRow = memo(HostRowImpl);

function SessionLeafNodeImpl({
  depth,
  getResourceTooltip,
  isMultiSelected,
  isPendingBreakpoint,
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
  const isSingleSelected = selected && !isMultiSelected;
  const isMultiOnly = isMultiSelected && !selected;

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
        ...(isMultiSelected && !isSingleSelected
          ? {
              bgcolor: alpha(
                theme.palette.secondary.main,
                theme.palette.mode === "dark" ? 0.22 : 0.14,
              ),
              "&::before": {
                bgcolor: "secondary.main",
                borderRadius: 999,
                content: '""',
                height: 16,
                left: 2,
                position: "absolute",
                top: "50%",
                transform: "translateY(-50%)",
                width: 3,
              },
              "&:hover": {
                bgcolor: alpha(
                  theme.palette.secondary.main,
                  theme.palette.mode === "dark" ? 0.3 : 0.2,
                ),
              },
            }
          : {}),
        ...(isMultiOnly
          ? {
              "&::before": {
                bgcolor: "secondary.main",
                borderRadius: 999,
                content: '""',
                height: 16,
                left: 2,
                position: "absolute",
                top: "50%",
                transform: "translateY(-50%)",
                width: 3,
              },
            }
          : {}),
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
        title={buildLeafTooltip(session, resourceKind, getResourceTooltip, t, isPendingBreakpoint)}
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
                color: theme.palette.text.primary,
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
                color: theme.palette.text.primary,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              })}
              variant="body2"
            >
              {querySuffix}
            </Typography>
          ) : null}
          {isPendingBreakpoint ? (
            <Tooltip arrow title={t("sessionExplorer.breakpointPending")}>
              <Box
                aria-label={t("sessionExplorer.breakpointPending")}
                component="span"
                sx={{
                  alignItems: "center",
                  color: "warning.main",
                  display: "inline-flex",
                  ml: 0.5,
                }}
              >
                <PauseCircleRoundedIcon sx={{ fontSize: 15 }} />
              </Box>
            </Tooltip>
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
  isPendingBreakpoint = false,
): string {
  const kindLabel = getResourceTooltip(resourceKind);
  let detail: string;

  if (session.statusCode <= 0) {
    detail = t("sessionExplorer.tooltipPending", { method: session.method, url: session.url });
  } else {
    detail = t("sessionExplorer.tooltipResolved", {
      kind: kindLabel,
      method: session.method,
      statusCode: session.statusCode,
      url: session.url,
    });
  }

  const hints: string[] = [];
  if (isPendingBreakpoint) {
    hints.push(t("sessionExplorer.breakpointPending"));
  }
  hints.push(t("sessionExplorer.tooltipShortcuts"));

  return `${detail}\n${hints.join("\n")}`;
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
