import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import { ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";

import { useI18n } from "@/i18n";

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

  if (!host) {
    return null;
  }

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={{
        paper: {
          sx: { minWidth: 180 },
        },
      }}
    >
      {isHostFocused ? (
        <MenuItem
          onClick={() => {
            onUnfocusHost();
            onClose();
          }}
        >
          <ListItemIcon>
            <VisibilityRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("contextMenu.unfocusHost")}</ListItemText>
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            onFocusHost(host);
            onClose();
          }}
        >
          <ListItemIcon>
            <VisibilityRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("contextMenu.focusHost")}</ListItemText>
        </MenuItem>
      )}

      {isHostIgnored ? (
        <MenuItem
          onClick={() => {
            onStopIgnoringHost(host);
            onClose();
          }}
        >
          <ListItemIcon>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("contextMenu.stopIgnoringHost")}</ListItemText>
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            onIgnoreHost(host);
            onClose();
          }}
        >
          <ListItemIcon>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("contextMenu.ignoreHost")}</ListItemText>
        </MenuItem>
      )}
    </Menu>
  );
}
