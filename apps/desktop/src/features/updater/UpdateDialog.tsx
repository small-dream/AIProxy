import { openUrl } from "@tauri-apps/plugin-opener";
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
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { useI18n } from "@/i18n";
import { pickLocalizedChangelog } from "@/features/updater/release-notes";
import { installUpdateAndStore } from "@/features/updater/update-status";

export function UpdateDialog() {
  const { t, locale } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const lastCheckFailed = useAppShellStore((s) => s.lastCheckFailed);
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
    : lastCheckFailed && !availableUpdate
      ? t("settingsPage.updateDialogCheckFailed")
      : availableUpdate
        ? t("settingsPage.updateDialogTitle", { version: availableUpdate.version })
        : t("settingsPage.updateDialogNoUpdate");

  const changelog = pickLocalizedChangelog(availableUpdate?.body, locale);

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
        {isInstalling ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2">{t("settingsPage.updatesInstalling")}</Typography>
          </Box>
        ) : null}
        {availableUpdate ? (
          <Box sx={{ mt: isChecking ? 2 : 0 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("settingsPage.updateDialogChangelog")}
            </Typography>
            {changelog ? (
              <MarkdownRenderer density="compact" onExternalLink={openUrl}>
                {changelog}
              </MarkdownRenderer>
            ) : (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {t("settingsPage.updateDialogNoChangelog")}
              </Typography>
            )}
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
