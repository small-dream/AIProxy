import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import { ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useTheme } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "./context-menu.styles";

type DomainContextMenuProps = {
  anchorPosition: { left: number; top: number } | undefined;
  host: string | null;
  isHostFocused: boolean;
  isHostIgnored: boolean;
  onClose: () => void;
  onFocusHost: (host: string) => void;
  onIgnoreHost: (host: string) => void;
  onStopIgnoringHost: (host: string) => void;
  onUnfocusHost: () => void;
};

export function DomainContextMenu({
  anchorPosition,
  host,
  isHostFocused,
  isHostIgnored,
  onClose,
  onFocusHost,
  onIgnoreHost,
  onStopIgnoringHost,
  onUnfocusHost,
}: DomainContextMenuProps) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!host) {
    return null;
  }

  const menuItemSx = getContextMenuItemSx(theme);
  const iconSx = getContextMenuIconSx(theme);

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={buildContextMenuSlotProps(196)}
    >
      {isHostFocused ? (
        <MenuItem
          onClick={() => {
            onUnfocusHost();
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <VisibilityRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.unfocusHost")}</ListItemText>
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            onFocusHost(host);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <VisibilityRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.focusHost")}</ListItemText>
        </MenuItem>
      )}

      {isHostIgnored ? (
        <MenuItem
          onClick={() => {
            onStopIgnoringHost(host);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.stopIgnoringHost")}</ListItemText>
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            onIgnoreHost(host);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.ignoreHost")}</ListItemText>
        </MenuItem>
      )}
    </Menu>
  );
}
