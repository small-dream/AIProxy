import type { SessionSummary } from "@aiproxy/shared-types";

import AddCircleOutlineRoundedIcon from "@mui/icons-material/AddCircleOutlineRounded";
import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import FolderCopyRoundedIcon from "@mui/icons-material/FolderCopyRounded";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import LockOpenRoundedIcon from "@mui/icons-material/LockOpenRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import RemoveCircleOutlineRoundedIcon from "@mui/icons-material/RemoveCircleOutlineRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
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

type SessionContextMenuProps = {
  anchorPosition: { left: number; top: number } | undefined;
  isHostFocused: boolean;
  isHostIgnored: boolean;
  isHostSslDecryptDisabled: boolean;
  session: SessionSummary | null;
  onClose: () => void;
  onClearOthers: (session: SessionSummary) => void;
  onCompose: (session: SessionSummary) => void;
  onCompareWith: (session: SessionSummary) => void;
  onCopyCurl: (session: SessionSummary) => void;
  onCopyRequest: (session: SessionSummary) => void;
  onCopyResponse: (session: SessionSummary) => void;
  onCopyUrl: (session: SessionSummary) => void;
  onCreateRewrite: (session: SessionSummary) => void;
  onCreateMapLocal: (session: SessionSummary) => void;
  onCreateThrottleRule: (session: SessionSummary) => void;
  onExportSession: (session: SessionSummary) => void;
  onFocusHost: (session: SessionSummary) => void;
  onGoToBreakpoints: () => void;
  onGoToRules: () => void;
  onIgnoreHost: (session: SessionSummary) => void;
  onRepeat: (session: SessionSummary) => void;
  onSaveResponse: (session: SessionSummary) => void;
  onSaveToCollection: (session: SessionSummary) => void;
  onSetCompareBase: (session: SessionSummary) => void;
  onStopIgnoringHost: (session: SessionSummary) => void;
  onToggleSslDecrypt: (session: SessionSummary) => void;
  onUnfocusHost: (session: SessionSummary) => void;
};

export function SessionContextMenu({
  anchorPosition,
  isHostFocused,
  isHostIgnored,
  isHostSslDecryptDisabled,
  session,
  onClose,
  onClearOthers,
  onCompose,
  onCompareWith,
  onCopyCurl,
  onCopyRequest,
  onCopyResponse,
  onCopyUrl,
  onCreateRewrite,
  onCreateMapLocal,
  onCreateThrottleRule,
  onExportSession,
  onFocusHost,
  onGoToBreakpoints,
  onGoToRules,
  onIgnoreHost,
  onRepeat,
  onSaveResponse,
  onSaveToCollection,
  onSetCompareBase,
  onStopIgnoringHost,
  onToggleSslDecrypt,
  onUnfocusHost,
}: SessionContextMenuProps) {
  const { t } = useI18n();
  const theme = useTheme();

  if (!session) {
    return null;
  }

  const menuItemSx = getContextMenuItemSx(theme);
  const iconSx = getContextMenuIconSx(theme);
  const dividerSx = getContextMenuDividerSx(theme);

  // P2 4.3-9: menu actions report their own failures via snackbar, but a stray
  // rejection must never escape as an unhandled promise rejection from the
  // click handler itself.
  const handleClick = (action: (session: SessionSummary) => void) => () => {
    const result = action(session) as unknown;
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
    onClose();
  };

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={buildContextMenuSlotProps(220)}
    >
      <MenuItem onClick={handleClick(onCopyUrl)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.copyUrl")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCopyRequest)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.copyRequest")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCopyCurl)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.copyAsCurl")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCopyResponse)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.copyResponse")}</ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onSetCompareBase)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <CompareArrowsRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.setCompareBase")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCompareWith)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <CompareArrowsRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.compareWith")}</ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onSaveResponse)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <SaveAltRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.saveResponse")}</ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onCompose)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <EditRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.compose")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onRepeat)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <ReplayRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.repeat")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onSaveToCollection)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <FolderCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("collectionsPage.saveToCollection")}
        </ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onExportSession)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <FileDownloadRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.exportSession")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onClearOthers)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <DeleteSweepRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.clearOthers")}</ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      {isHostFocused ? (
        <MenuItem
          onClick={() => {
            onUnfocusHost(session);
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
        <MenuItem onClick={handleClick(onFocusHost)} sx={menuItemSx}>
          <ListItemIcon sx={iconSx}>
            <AddCircleOutlineRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.focusHost")}</ListItemText>
        </MenuItem>
      )}

      {isHostIgnored ? (
        <MenuItem onClick={handleClick(onStopIgnoringHost)} sx={menuItemSx}>
          <ListItemIcon sx={iconSx}>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>
            {t("contextMenu.stopIgnoringHost")}
          </ListItemText>
        </MenuItem>
      ) : (
        <MenuItem onClick={handleClick(onIgnoreHost)} sx={menuItemSx}>
          <ListItemIcon sx={iconSx}>
            <VisibilityOffRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.ignoreHost")}</ListItemText>
        </MenuItem>
      )}

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onToggleSslDecrypt)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          {isHostSslDecryptDisabled ? (
            <LockOpenRoundedIcon fontSize="small" />
          ) : (
            <LockRoundedIcon fontSize="small" />
          )}
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {isHostSslDecryptDisabled
            ? t("contextMenu.sslDecryptEnable")
            : t("contextMenu.sslDecryptDisable")}
        </ListItemText>
      </MenuItem>

      <Divider sx={dividerSx} />

      <MenuItem onClick={handleClick(onCreateRewrite)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <AltRouteRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.createRewrite")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCreateMapLocal)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <FolderOpenRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.mapLocal")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCreateThrottleRule)} sx={menuItemSx}>
        <ListItemIcon sx={iconSx}>
          <SpeedRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("contextMenu.createThrottleRule")}
        </ListItemText>
      </MenuItem>

      <MenuItem
        onClick={() => {
          onGoToBreakpoints();
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <RuleRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>
          {t("contextMenu.goToBreakpoints")}
        </ListItemText>
      </MenuItem>

      <MenuItem
        onClick={() => {
          onGoToRules();
          onClose();
        }}
        sx={menuItemSx}
      >
        <ListItemIcon sx={iconSx}>
          <AltRouteRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText {...contextMenuItemTextProps}>{t("contextMenu.goToRules")}</ListItemText>
      </MenuItem>
    </Menu>
  );
}
