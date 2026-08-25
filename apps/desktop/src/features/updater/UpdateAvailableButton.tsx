import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { TopBarActionButton } from "@/components/shared/TopBarActionButton";
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

  const label = t("appShell.updateAvailableAction");

  return (
    <TopBarActionButton
      icon={<SystemUpdateAltRoundedIcon />}
      label={label}
      onClick={() => setUpdateDialogOpen(true)}
    />
  );
}
