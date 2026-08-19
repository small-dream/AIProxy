import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";
import { Button, Tooltip } from "@mui/material";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useI18n } from "@/i18n";

/** A quiet, shell-level entry point for an update discovered at startup. */
export function UpdateAvailableButton() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((state) => state.availableUpdate);
  const isInstalling = useAppShellStore((state) => state.isInstalling);
  const setUpdateDialogOpen = useAppShellStore((state) => state.setUpdateDialogOpen);

  if (!availableUpdate || isInstalling) {
    return null;
  }

  const label = t("appShell.updateAvailableAction", { version: availableUpdate.version });

  return (
    <Tooltip arrow title={t("appShell.updateAvailableTooltip")}>
      <Button
        aria-label={label}
        onClick={() => setUpdateDialogOpen(true)}
        size="small"
        startIcon={<SystemUpdateAltRoundedIcon />}
        variant="outlined"
        sx={(theme) => ({
          borderColor: theme.palette.warning.main,
          borderRadius: 999,
          color: theme.palette.warning.main,
          fontSize: 12,
          fontWeight: 600,
          minHeight: 28,
          minWidth: 0,
          px: 1.25,
          py: 0.25,
          whiteSpace: "nowrap",
          "&:hover": {
            bgcolor:
              theme.palette.mode === "dark" ? "rgba(251, 191, 36, 0.14)" : "rgba(180, 83, 9, 0.08)",
            borderColor: theme.palette.warning.dark,
          },
          "& .MuiButton-startIcon": { mr: 0.5 },
          "& .MuiSvgIcon-root": { fontSize: 16 },
        })}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
