import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import FilterAltOffRoundedIcon from "@mui/icons-material/FilterAltOffRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useTheme } from "@mui/material/styles";

import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuDividerSx,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "@/features/sessions/components/context-menu.styles";
import { normalizeHostValue } from "@/features/insights/compute-insights.helpers";
import { useI18n } from "@/i18n";

export type HostContextMenuState = {
  anchorPosition: { left: number; top: number };
  host: string;
  selectedText?: string;
};

export function HostContextMenu({
  anchorPosition,
  host,
  hostExact,
  selectedText,
  onClose,
  onCopyHost,
  onExcludeHost,
  onFilterHost,
  onFilterSelection,
  onOpenSessions,
}: {
  anchorPosition: { left: number; top: number } | undefined;
  host: string | null;
  hostExact: string | null;
  selectedText?: string | undefined;
  onClose: () => void;
  onCopyHost: (host: string) => void;
  onExcludeHost: (host: string) => void;
  onFilterHost: (host: string) => void;
  onFilterSelection: (value: string) => void;
  onOpenSessions: (host: string) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!host) {
    return null;
  }

  const isExactHostActive = normalizeHostValue(hostExact ?? "") === normalizeHostValue(host);
  const menuItemSx = getContextMenuItemSx(theme);
  const iconSx = getContextMenuIconSx(theme);
  const dividerSx = getContextMenuDividerSx(theme);

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={buildContextMenuSlotProps(220)}
    >
      <MenuItem
        disabled={isExactHostActive}
        onClick={() => {
          onFilterHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <FilterAltRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.filterByHost")}
        </ListItemText>
      </MenuItem>

      {selectedText && normalizeHostValue(selectedText) !== normalizeHostValue(host) ? (
        <MenuItem
          onClick={() => {
            onFilterSelection(selectedText);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <SearchRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>
            {t("insightsPage.hosts.contextMenu.filterBySelection")}
          </ListItemText>
        </MenuItem>
      ) : null}

      <MenuItem
        onClick={() => {
          onExcludeHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <FilterAltOffRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.excludeHost")}
        </ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem
        onClick={() => {
          onCopyHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.copyHost")}
        </ListItemText>
      </MenuItem>

      <MenuItem
        onClick={() => {
          onOpenSessions(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <OpenInNewRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("insightsPage.hosts.contextMenu.showRequests")}
        </ListItemText>
      </MenuItem>
    </Menu>
  );
}
