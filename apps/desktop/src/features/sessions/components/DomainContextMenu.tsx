import AddCircleOutlineRoundedIcon from "@mui/icons-material/AddCircleOutlineRounded";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import RemoveCircleOutlineRoundedIcon from "@mui/icons-material/RemoveCircleOutlineRounded";
import SaveAltRoundedIcon from "@mui/icons-material/SaveAltRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useTheme } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuDividerSx,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "./context-menu.styles";

type DomainContextMenuProps = {
  anchorPosition: { left: number; top: number } | undefined;
  host: string | null;
  isHostFocused: boolean;
  isHostIgnored: boolean;
  onClose: () => void;
  onExportHost: (host: string) => void;
  onFocusHost: (host: string) => void;
  onIgnoreHost: (host: string) => void;
  onSaveHostFiles: (host: string) => void;
  onStopIgnoringHost: (host: string) => void;
  onUnfocusHost: (host: string) => void;
};

export function DomainContextMenu({
  anchorPosition,
  host,
  isHostFocused,
  isHostIgnored,
  onClose,
  onExportHost,
  onFocusHost,
  onIgnoreHost,
  onSaveHostFiles,
  onStopIgnoringHost,
  onUnfocusHost,
}: DomainContextMenuProps) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!host) {
    return null;
  }

  const menuItemSx = getContextMenuItemSx(theme);
  const dividerSx = getContextMenuDividerSx(theme);
  const iconSx = getContextMenuIconSx(theme);

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={buildContextMenuSlotProps(180)}
    >
      <MenuItem
        onClick={() => {
          onSaveHostFiles(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <SaveAltRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("contextMenu.saveResponseFiles")}
        </ListItemText>
      </MenuItem>

      <MenuItem
        onClick={() => {
          onExportHost(host);
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <FileDownloadRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.exportHost")}</ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      {isHostFocused ? (
        <MenuItem
          onClick={() => {
            onUnfocusHost(host);
            onClose();
          }}
          sx={menuItemSx}
        >
          <ListItemIcon sx={iconSx}>
            <RemoveCircleOutlineRoundedIcon fontSize="small" />
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
            <AddCircleOutlineRoundedIcon fontSize="small" />
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
          <ListItemText {...contextMenuItemTextProps}>
            {t("contextMenu.stopIgnoringHost")}
          </ListItemText>
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
