import { DEFAULT_PROXY_PORT } from "@aiproxy/shared-types";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  OutlinedInput,
  Stack,
  Typography,
} from "@mui/material";

import { useI18n } from "@/i18n";

type AppShellDialogsProps = {
  isBusy: boolean;
  isRunning: boolean;
  onClosePortDialog: () => void;
  onPortApply: () => void;
  onPortDraftChange: (value: string) => void;
  portDialogError: string | null;
  portDialogOpen: boolean;
  portDraft: string;
};

export function AppShellDialogs({
  isBusy,
  isRunning,
  onClosePortDialog,
  onPortApply,
  onPortDraftChange,
  portDialogError,
  portDialogOpen,
  portDraft,
}: AppShellDialogsProps) {
  const { t } = useI18n();

  return (
    <>
      <Dialog fullWidth maxWidth="xs" onClose={onClosePortDialog} open={portDialogOpen}>
        <Stack
          component="form"
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            void onPortApply();
          }}
        >
          <DialogTitle>{t("appShell.changePortTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {isRunning
                  ? t("appShell.portChangesRestartImmediately")
                  : t("appShell.portChangesStartOnNewPort")}
              </Typography>
              <OutlinedInput
                autoFocus
                error={Boolean(portDialogError)}
                inputProps={{ inputMode: "numeric", max: 65535, min: 1, pattern: "[0-9]*" }}
                onChange={(event) => onPortDraftChange(event.target.value)}
                placeholder={String(DEFAULT_PROXY_PORT)}
                value={portDraft}
              />
              {portDialogError ? (
                <Typography color="error" variant="caption">
                  {portDialogError}
                </Typography>
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={onClosePortDialog}>{t("common.actions.cancel")}</Button>
            <Button disabled={isBusy} type="submit" variant="contained">
              {isRunning ? t("common.actions.applyAndRestart") : t("common.actions.startOnNewPort")}
            </Button>
          </DialogActions>
        </Stack>
      </Dialog>
    </>
  );
}
