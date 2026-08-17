import SaveAltRoundedIcon from "@mui/icons-material/SaveAltRounded";
import { ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useTheme } from "@mui/material/styles";

import { useI18n } from "@/i18n";
import {
  buildContextMenuSlotProps,
  contextMenuItemTextProps,
  getContextMenuIconSx,
  getContextMenuItemSx,
} from "./context-menu.styles";

export type SessionFolderContextTarget = {
  /** Label shown to the user, e.g. the path segment `static`. */
  label: string;
  /** Every session under the folder, including nested subfolders. */
  sessionCount: number;
};

type SessionFolderContextMenuProps = {
  anchorPosition: { left: number; top: number } | undefined;
  onClose: () => void;
  onSaveFiles: () => void;
  target: SessionFolderContextTarget | null;
};

/**
 * Context menu for a path ("folder") node in the session tree. Host nodes keep
 * the host-scoped `DomainContextMenu`; this one covers the intermediate URL
 * path segments, which previously had no context menu at all.
 */
export function SessionFolderContextMenu({
  anchorPosition,
  onClose,
  onSaveFiles,
  target,
}: SessionFolderContextMenuProps) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!target) {
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
      slotProps={buildContextMenuSlotProps(220)}
    >
      <MenuItem
        disabled={target.sessionCount === 0}
        onClick={() => {
          onSaveFiles();
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
    </Menu>
  );
}
