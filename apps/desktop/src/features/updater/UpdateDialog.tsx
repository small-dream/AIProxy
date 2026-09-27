import { openUrl } from "@tauri-apps/plugin-opener";
import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
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
  const progressPercent =
    updateProgress?.contentLength && updateProgress.contentLength > 0
      ? Math.min(100, Math.round((updateProgress.downloaded / updateProgress.contentLength) * 100))
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
      <DialogTitle sx={{ pb: 1.5 }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
          <Box
            sx={(theme) => ({
              alignItems: "center",
              bgcolor: theme.palette.action.selected,
              borderRadius: 1.5,
              color: "primary.main",
              display: "inline-flex",
              height: 36,
              justifyContent: "center",
              width: 36,
            })}
          >
            <SystemUpdateAltRoundedIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="div" variant="h6" sx={{ fontWeight: 600 }}>
              {title}
            </Typography>
            {availableUpdate ? (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("settingsPage.updateDialogCurrentVersion", {
                  currentVersion: availableUpdate.currentVersion,
                })}
              </Typography>
            ) : null}
          </Box>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {isChecking ? (
          <Box sx={{ alignItems: "center", display: "flex", gap: 1, py: 1 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("settingsPage.updatesChecking")}
            </Typography>
          </Box>
        ) : null}
        {isInstalling ? (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ alignItems: "center", display: "flex", gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2">{t("settingsPage.updatesInstalling")}</Typography>
            </Box>
            {progressPercent !== null ? (
              <LinearProgress
                aria-label={t("settingsPage.updatesInstalling")}
                value={progressPercent}
                variant="determinate"
                sx={{ borderRadius: 999, height: 6, mt: 1.25 }}
              />
            ) : null}
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
