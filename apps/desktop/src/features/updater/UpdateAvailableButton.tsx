import { Button } from "@mui/material";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useI18n } from "@/i18n";

/** A compact shell-level action for an update discovered at startup. */
export function UpdateAvailableButton() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((state) => state.availableUpdate);
  const isInstalling = useAppShellStore((state) => state.isInstalling);
  const setUpdateDialogOpen = useAppShellStore((state) => state.setUpdateDialogOpen);

  if (!availableUpdate || isInstalling) {
    return null;
  }

  const label = t("appShell.updateAvailableAction");

  return (
    <Button
      onClick={() => setUpdateDialogOpen(true)}
      disableElevation
      variant="contained"
      size="small"
      sx={{
        borderRadius: 1.5,
        fontSize: 13,
        fontWeight: 600,
        height: 32,
        minWidth: 72,
        px: 1.75,
        py: 0,
      }}
    >
      {label}
    </Button>
  );
}
