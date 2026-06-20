import { DEFAULT_PROXY_PORT, type PortOccupant } from "@aiproxy/shared-types";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  OutlinedInput,
  Stack,
  Typography,
} from "@mui/material";

import type { PortInUseFailure } from "@/features/proxy-status/proxy-start.store";
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
  // Port-in-use recovery: optionally end the occupying process and restart.
  portInUse: PortInUseFailure | null;
  occupant: PortOccupant | null;
  occupantLoading: boolean;
  killConfirmOpen: boolean;
  onOpenKillConfirm: () => void;
  onCloseKillConfirm: () => void;
  onKillAndRestart: () => void;
  isKilling: boolean;
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
  portInUse,
  occupant,
  occupantLoading,
  killConfirmOpen,
  onOpenKillConfirm,
  onCloseKillConfirm,
  onKillAndRestart,
  isKilling,
}: AppShellDialogsProps) {
  const { t } = useI18n();
  const showKillAction = portInUse !== null && occupant !== null;
  const killActionDisabled = occupantLoading || isBusy || isKilling;

  const portField = (
    <>
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
    </>
  );

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
          <DialogTitle>
            {portInUse ? t("appShell.resolvePortConflictTitle") : t("appShell.changePortTitle")}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              {portInUse ? (
                <>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {t("appShell.portInUseByProcess", { port: portInUse.port })}
                  </Typography>

                  {/* Path 1: end the occupying process and restart on the same port */}
                  <Stack spacing={1}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {t("appShell.endProcessSectionLabel")}
                    </Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {occupantLoading
                        ? t("appShell.portOccupantResolving", { port: portInUse.port })
                        : occupant
                          ? t("appShell.processWithPid", {
                              name: occupant.name,
                              pid: occupant.pid,
                            })
                          : t("appShell.portOccupantUnresolved")}
                    </Typography>
                    {showKillAction ? (
                      <Button
                        color="error"
                        disabled={killActionDisabled}
                        onClick={onOpenKillConfirm}
                        size="small"
                        variant="outlined"
                      >
                        {t("appShell.endProcessAndRestartOnPort", {
                          name: occupant?.name ?? "",
                          port: portInUse.port,
                        })}
                      </Button>
                    ) : null}
                  </Stack>

                  <Divider>{t("appShell.orDivider")}</Divider>

                  {/* Path 2: start on a different port */}
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {t("appShell.startOnDifferentPort")}
                  </Typography>
                  {portField}
                </>
              ) : (
                <>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {isRunning
                      ? t("appShell.portChangesRestartImmediately")
                      : t("appShell.portChangesStartOnNewPort")}
                  </Typography>
                  {portField}
                </>
              )}
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

      <Dialog fullWidth maxWidth="xs" onClose={onCloseKillConfirm} open={killConfirmOpen}>
        <DialogTitle>{t("appShell.killProcessTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {occupant
              ? t("appShell.killProcessWarning", { name: occupant.name, pid: occupant.pid })
              : t("appShell.killProcessWarningGeneric")}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button disabled={isKilling} onClick={onCloseKillConfirm}>
            {t("common.actions.cancel")}
          </Button>
          <Button color="error" disabled={isKilling} onClick={onKillAndRestart} variant="contained">
            {t("appShell.killProcessConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
