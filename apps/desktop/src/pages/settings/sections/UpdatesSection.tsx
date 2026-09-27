import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";
import { Alert, Box, Button, Snackbar, Typography } from "@mui/material";
import { useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { checkForUpdateAndStore, installUpdateAndStore } from "@/features/updater/update-status";
import { useI18n } from "@/i18n";
import { SettingsFooter, SettingsGroup } from "../SettingsLayoutParts";

export function UpdatesSection() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const updateProgress = useAppShellStore((s) => s.updateProgress);
  const [checkToast, setCheckToast] = useState<{
    message: string;
    severity: "success" | "error";
  } | null>(null);

  async function handleCheck() {
    const ok = await checkForUpdateAndStore();
    if (!ok) {
      setCheckToast({ message: t("common.errors.generic"), severity: "error" });
      return;
    }
    if (useAppShellStore.getState().availableUpdate === null) {
      setCheckToast({ message: t("settingsPage.updatesNone"), severity: "success" });
    }
  }

  async function handleInstall() {
    try {
      await installUpdateAndStore();
    } catch {
      // helper logs + resets isInstalling
    }
  }

  const progressText =
    updateProgress && updateProgress.contentLength
      ? t("settingsPage.updatesProgress", {
          downloaded: Math.round(updateProgress.downloaded / 1024).toString(),
          total: Math.round(updateProgress.contentLength / 1024).toString(),
        })
      : null;

  return (
    <SectionCard
      compact
      title={t("settingsPage.updatesSectionTitle")}
      description={t("settingsPage.updatesDescription")}
    >
      <SettingsGroup>
        <SettingsFooter
          hint={
            <Box sx={{ minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{ color: availableUpdate ? "text.primary" : "text.secondary" }}
              >
                {availableUpdate
                  ? t("settingsPage.updatesAvailableDetail", {
                      currentVersion: availableUpdate.currentVersion,
                      version: availableUpdate.version,
                    })
                  : t("settingsPage.updatesIdle")}
              </Typography>
              {progressText ? (
                <Typography
                  variant="caption"
                  sx={{ display: "block", color: "text.secondary", mt: 0.25 }}
                >
                  {progressText}
                </Typography>
              ) : null}
            </Box>
          }
        >
          <Button
            size="small"
            variant="outlined"
            startIcon={<SystemUpdateAltRoundedIcon />}
            onClick={() => void handleCheck()}
            disabled={isChecking || isInstalling}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isChecking
              ? t("settingsPage.updatesCheckingAction")
              : t("settingsPage.updatesCheckAction")}
          </Button>

          {availableUpdate ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<DownloadRoundedIcon />}
              onClick={() => void handleInstall()}
              disabled={isChecking || isInstalling}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isInstalling
                ? t("settingsPage.updatesInstallingAction")
                : t("settingsPage.updatesInstallAction")}
            </Button>
          ) : null}
        </SettingsFooter>
      </SettingsGroup>

      <Snackbar
        open={checkToast !== null}
        autoHideDuration={3000}
        onClose={() => setCheckToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={checkToast?.severity ?? "success"}
          variant="filled"
          onClose={() => setCheckToast(null)}
        >
          {checkToast?.message}
        </Alert>
      </Snackbar>
    </SectionCard>
  );
}
