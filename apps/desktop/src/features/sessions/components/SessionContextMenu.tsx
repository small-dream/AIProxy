import type { SessionSummary } from "@pharles/shared-types";

import AltRouteRoundedIcon from "@mui/icons-material/AltRouteRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteSweepRoundedIcon from "@mui/icons-material/DeleteSweepRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SaveAltRoundedIcon from "@mui/icons-material/SaveAltRounded";
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";

import { useI18n } from "@/i18n";

type SessionContextMenuProps = {
  anchorPosition: { left: number; top: number } | undefined;
  session: SessionSummary | null;
  onClose: () => void;
  onCopyUrl: (session: SessionSummary) => void;
  onCopyRequest: (session: SessionSummary) => void;
  onCopyResponse: (session: SessionSummary) => void;
  onSaveResponse: (session: SessionSummary) => void;
  onCompose: (session: SessionSummary) => void;
  onRepeat: (session: SessionSummary) => void;
  onExportSession: (session: SessionSummary) => void;
  onClearOthers: (session: SessionSummary) => void;
  onGoToBreakpoints: () => void;
  onGoToRules: () => void;
};

export function SessionContextMenu({
  anchorPosition,
  session,
  onClose,
  onCopyUrl,
  onCopyRequest,
  onCopyResponse,
  onSaveResponse,
  onCompose,
  onRepeat,
  onExportSession,
  onClearOthers,
  onGoToBreakpoints,
  onGoToRules,
}: SessionContextMenuProps) {
  const { t } = useI18n();

  if (!session) {
    return null;
  }

  const handleClick = (action: (session: SessionSummary) => void) => () => {
    action(session);
    onClose();
  };

  return (
    <Menu
      anchorPosition={anchorPosition ?? { left: 0, top: 0 }}
      anchorReference="anchorPosition"
      onClose={onClose}
      open={anchorPosition !== undefined}
      slotProps={{
        paper: {
          sx: { minWidth: 200 },
        },
      }}
    >
      <MenuItem onClick={handleClick(onCopyUrl)}>
        <ListItemIcon>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.copyUrl")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCopyRequest)}>
        <ListItemIcon>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.copyRequest")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onCopyResponse)}>
        <ListItemIcon>
          <ContentCopyRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.copyResponse")}</ListItemText>
      </MenuItem>

      <Divider />

      <MenuItem onClick={handleClick(onSaveResponse)}>
        <ListItemIcon>
          <SaveAltRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.saveResponse")}</ListItemText>
      </MenuItem>

      <Divider />

      <MenuItem onClick={handleClick(onCompose)}>
        <ListItemIcon>
          <EditRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.compose")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onRepeat)}>
        <ListItemIcon>
          <ReplayRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.repeat")}</ListItemText>
      </MenuItem>

      <Divider />

      <MenuItem onClick={handleClick(onExportSession)}>
        <ListItemIcon>
          <FileDownloadRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.exportSession")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={handleClick(onClearOthers)}>
        <ListItemIcon>
          <DeleteSweepRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.clearOthers")}</ListItemText>
      </MenuItem>

      <Divider />

      <MenuItem onClick={() => { onGoToBreakpoints(); onClose(); }}>
        <ListItemIcon>
          <RuleRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.goToBreakpoints")}</ListItemText>
      </MenuItem>

      <MenuItem onClick={() => { onGoToRules(); onClose(); }}>
        <ListItemIcon>
          <AltRouteRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("contextMenu.goToRules")}</ListItemText>
      </MenuItem>
    </Menu>
  );
}
