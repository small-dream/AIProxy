import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useI18n } from "@/i18n";
import { installUpdateAndStore } from "@/features/updater/update-status";

export function UpdateDialog() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const updateProgress = useAppShellStore((s) => s.updateProgress);
  const isOpen = useAppShellStore((s) => s.isUpdateDialogOpen);
  const setUpdateDialogOpen = useAppShellStore((s) => s.setUpdateDialogOpen);

  if (!isOpen) {
    return null;
  }

  const progressText =
    updateProgress && updateProgress.contentLength
      ? t("settingsPage.updatesProgress", {
          downloaded: Math.round(updateProgress.downloaded / 1024).toString(),
          total: Math.round(updateProgress.contentLength / 1024).toString(),
        })
      : null;

  const title = isChecking
    ? t("settingsPage.updatesChecking")
    : availableUpdate
      ? t("settingsPage.updateDialogTitle", { version: availableUpdate.version })
      : t("settingsPage.updateDialogNoUpdate");

  async function handleUpdate() {
    try {
      await installUpdateAndStore();
      // installPendingAppUpdate relaunches the app on success.
    } catch {
      // Error already logged by the helper; keep dialog open so the user sees
      // the failure state and can retry or dismiss.
    }
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={isInstalling ? undefined : () => setUpdateDialogOpen(false)}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {isChecking ? <CircularProgress size={24} /> : null}
        {availableUpdate?.body ? (
          <Box sx={{ mt: isChecking ? 2 : 0 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("settingsPage.updateDialogChangelog")}
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {availableUpdate.body}
            </Typography>
          </Box>
        ) : null}
        {isInstalling && progressText ? (
          <Typography variant="caption" sx={{ display: "block", mt: 1 }}>
            {progressText}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        {availableUpdate && !isInstalling ? (
          <Button onClick={() => void handleUpdate()} variant="contained">
            {t("settingsPage.updateDialogUpdateNow")}
          </Button>
        ) : null}
        {!isInstalling ? (
          <Button onClick={() => setUpdateDialogOpen(false)}>
            {availableUpdate ? t("settingsPage.updateDialogLater") : t("common.actions.close")}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
