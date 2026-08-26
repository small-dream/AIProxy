import { Button } from "@mui/material";
import { alpha } from "@mui/material/styles";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useI18n } from "@/i18n";

/**
 * Accent colors for the quiet, text-only update entry. Matches the blue VS Code
 * uses for its action/link text: Light+ `textLink.foreground` (#006AB1) and
 * Dark+ (#3794FF).
 */
const UPDATE_ACCENT = {
  dark: "#3794FF",
  light: "#006AB1",
} as const;

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
    <Button
      onClick={() => setUpdateDialogOpen(true)}
      size="small"
      sx={(theme) => {
        const accent = theme.palette.mode === "dark" ? UPDATE_ACCENT.dark : UPDATE_ACCENT.light;
        return {
          color: accent,
          fontSize: 13,
          fontWeight: 500,
          minWidth: 0,
          px: 1,
          py: 0.25,
          "&:hover": {
            backgroundColor: alpha(accent, theme.palette.mode === "dark" ? 0.16 : 0.1),
          },
        };
      }}
    >
      {label}
    </Button>
  );
}
